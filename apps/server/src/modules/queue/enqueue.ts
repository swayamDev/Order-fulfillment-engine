import type { Tx } from '@sethu/db';
import { sql } from 'kysely';

export interface EnqueueInput {
  readonly sandboxId: string;
  readonly queue: string;
  readonly payload: Record<string, unknown>;
  /** Jobs with the same key in the same sandbox are created once. */
  readonly dedupeKey?: string;
  readonly delayMs?: number;
  readonly maxAttempts?: number;
}

/**
 * Adds a job inside the caller's transaction, so the job exists if and only if
 * the caller's other writes commit. Returns false when the dedupe key was
 * already used.
 */
export async function enqueue(tx: Tx, input: EnqueueInput): Promise<boolean> {
  const result = await tx
    .insertInto('jobs')
    .values({
      sandbox_id: input.sandboxId,
      queue: input.queue,
      payload: input.payload,
      dedupe_key: input.dedupeKey ?? null,
      run_at: sql<Date>`now() + make_interval(secs => ${(input.delayMs ?? 0) / 1000})`,
      ...(input.maxAttempts === undefined ? {} : { max_attempts: input.maxAttempts }),
    })
    .onConflict((oc) => oc.columns(['sandbox_id', 'dedupe_key']).doNothing())
    .returning('id')
    .executeTakeFirst();
  return result !== undefined;
}
