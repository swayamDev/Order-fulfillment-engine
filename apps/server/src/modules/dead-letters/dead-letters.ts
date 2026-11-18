import { withSandbox, type Db } from '@sethu/db';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import { problem } from '../../http/problem.ts';
import type { SandboxGuard } from '../sandbox/index.ts';

export interface DeadLetterView {
  id: string;
  queue: string;
  attempts: number;
  maxAttempts: number;
  reason: string | null;
  failedAt: string | null;
  /** The order this job was working on, when it can be told. */
  orderId: string | null;
  replays: number;
}

/** Dead jobs in one sandbox, newest first. */
export async function listDeadLetters(db: Db, sandboxId: string): Promise<DeadLetterView[]> {
  return withSandbox(db, sandboxId, async (tx) => {
    const rows = await tx
      .selectFrom('jobs')
      .select([
        'jobs.id',
        'jobs.queue',
        'jobs.attempts',
        'jobs.max_attempts',
        'jobs.last_error',
        'jobs.finished_at',
        sql<string | null>`coalesce(
          jobs.payload->>'aggregateId',
          jobs.payload->>'orderId',
          (SELECT wi.payload->'data'->>'order_id' FROM webhook_inbox wi
            WHERE wi.id::text = jobs.payload->>'inboxId'),
          jobs.payload->'envelope'->'data'->>'order_id'
        )`.as('order_id'),
        sql<number>`(SELECT count(*)::int FROM job_replays r WHERE r.job_id = jobs.id)`.as(
          'replays',
        ),
      ])
      .where('jobs.status', '=', 'dead')
      .orderBy('jobs.finished_at', 'desc')
      .limit(200)
      .execute();
    return rows.map((r) => ({
      id: r.id,
      queue: r.queue,
      attempts: r.attempts,
      maxAttempts: r.max_attempts,
      reason: r.last_error,
      failedAt: r.finished_at?.toISOString() ?? null,
      orderId: r.order_id,
      replays: r.replays,
    }));
  });
}

export type ReplayResult =
  | { readonly kind: 'replayed' }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'not_dead'; readonly status: string };

/**
 * Puts a dead job back in the queue with fresh attempts, keeping what it had
 * failed with in job_replays. A replayed webhook gets a fresh holding window.
 * Safe because every consumer is idempotent: if the work had in fact been
 * done, the replay finds it done and changes nothing.
 */
export async function replayDeadLetter(
  db: Db,
  sandboxId: string,
  jobId: string,
  requestedBy: string,
): Promise<ReplayResult> {
  return withSandbox(db, sandboxId, async (tx) => {
    const job = await tx
      .selectFrom('jobs')
      .selectAll()
      .where('id', '=', jobId)
      .forUpdate()
      .executeTakeFirst();
    if (job === undefined) return { kind: 'not_found' };
    if (job.status !== 'dead') return { kind: 'not_dead', status: job.status };

    await tx
      .insertInto('job_replays')
      .values({
        sandbox_id: sandboxId,
        job_id: job.id,
        queue: job.queue,
        previous_error: job.last_error,
        previous_attempts: job.attempts,
        requested_by: requestedBy,
      })
      .execute();
    await tx
      .updateTable('jobs')
      .set({
        status: 'queued',
        attempts: 0,
        run_at: sql<Date>`now()`,
        last_error: null,
        finished_at: null,
        updated_at: sql<Date>`now()`,
      })
      .where('id', '=', job.id)
      .execute();
    const inboxId = job.payload['inboxId'];
    if (typeof inboxId === 'string') {
      await tx
        .updateTable('webhook_inbox')
        .set({ held_at: null })
        .where('id', '=', inboxId)
        .execute();
    }
    return { kind: 'replayed' };
  });
}

const Params = z.object({ id: z.uuid() });

export function deadLetterRoutes(
  app: FastifyInstance,
  db: Db,
  requireSandbox: SandboxGuard,
  onJobsQueued: () => void,
): void {
  const guard = { preHandler: requireSandbox };

  app.get('/v1/dead-letters', guard, (request) => listDeadLetters(db, request.sandboxId));

  app.post('/v1/dead-letters/:id/replay', guard, async (request, reply) => {
    const params = Params.safeParse(request.params);
    const result = params.success
      ? await replayDeadLetter(db, request.sandboxId, params.data.id, 'console')
      : ({ kind: 'not_found' } as const);
    switch (result.kind) {
      case 'not_found':
        return problem(reply, 404, 'not_found', 'No such job in this sandbox.');
      case 'not_dead':
        return problem(
          reply,
          409,
          'not_dead',
          `Only dead jobs can be replayed; this one is ${result.status}.`,
        );
      case 'replayed':
        onJobsQueued();
        return reply.code(202).send({ replayed: true });
    }
  });
}
