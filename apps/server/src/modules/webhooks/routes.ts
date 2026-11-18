import { withSandbox, type Db } from '@sethu/db';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import { problem } from '../../http/problem.ts';
import { enqueue } from '../queue/index.ts';
import { SIGNATURE_HEADER, verifySignature } from './signature.ts';

export const PROCESS_WEBHOOK = 'webhook.process';

/** The envelope every (simulated) provider sends. sandbox_id plays the part of Stripe-style metadata. */
export const WebhookEnvelope = z.object({
  id: z.string().min(1).max(100),
  type: z.string().min(1).max(100),
  created: z.number().int(),
  sandbox_id: z.uuid(),
  /** Set by Sethu's simulated providers; real providers would not send it. */
  simulated: z.literal(true).optional(),
  data: z.record(z.string(), z.unknown()),
});
export type WebhookEnvelope = z.infer<typeof WebhookEnvelope>;

export interface WebhookRouteDeps {
  readonly db: Db;
  /** Accepted secrets per provider; more than one during a rotation. */
  readonly secrets: ReadonlyMap<string, readonly string[]>;
  readonly onEventsCommitted: () => void;
  readonly nowSeconds?: () => number;
}

/**
 * Receives provider webhooks. Verifies the signature over the raw bytes,
 * stores the event in the inbox exactly once (a redelivered event id only
 * bumps duplicate_count), queues it for processing and answers fast.
 * Processing happens later, in a job, so a slow consumer never makes the
 * provider time out and retry.
 */
export async function webhookRoutes(app: FastifyInstance, deps: WebhookRouteDeps): Promise<void> {
  await app.register((scope, _opts, done) => {
    // Keep the raw body: the signature covers exact bytes, not re-serialised JSON.
    scope.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, next) => {
      next(null, body);
    });

    scope.post('/v1/webhooks/:provider', async (request, reply) => {
      const { provider } = request.params as { provider: string };
      const secrets = deps.secrets.get(provider);
      if (secrets === undefined) return problem(reply, 404, 'unknown_provider', provider);

      const raw = typeof request.body === 'string' ? request.body : '';
      const header = request.headers[SIGNATURE_HEADER];
      const verified = verifySignature({
        header: Array.isArray(header) ? header[0] : header,
        body: raw,
        secrets,
        ...(deps.nowSeconds === undefined ? {} : { nowSeconds: deps.nowSeconds() }),
      });
      if (!verified.ok) {
        request.log.warn({ provider, reason: verified.reason }, 'webhook rejected');
        return problem(
          reply,
          401,
          'invalid_signature',
          `Signature check failed: ${verified.reason}`,
        );
      }

      let envelope: WebhookEnvelope;
      try {
        envelope = WebhookEnvelope.parse(JSON.parse(raw));
      } catch {
        return problem(reply, 400, 'invalid_envelope', 'Signed, but not a valid webhook envelope.');
      }

      const stored = await withSandbox(deps.db, envelope.sandbox_id, async (tx) => {
        const live = await tx
          .selectFrom('sandboxes')
          .select('id')
          .where('expires_at', '>', sql<Date>`now()`)
          .executeTakeFirst();
        if (live === undefined) return undefined;

        const row = await tx
          .insertInto('webhook_inbox')
          .values({
            sandbox_id: envelope.sandbox_id,
            provider,
            provider_event_id: envelope.id,
            event_type: envelope.type,
            payload: envelope,
          })
          .onConflict((oc) =>
            oc.columns(['provider', 'provider_event_id']).doUpdateSet({
              duplicate_count: sql<number>`webhook_inbox.duplicate_count + 1`,
            }),
          )
          // xmax is 0 only for a freshly inserted row version.
          .returning(['id', sql<boolean>`xmax = 0`.as('inserted')])
          .executeTakeFirstOrThrow();

        if (row.inserted) {
          await enqueue(tx, {
            sandboxId: envelope.sandbox_id,
            queue: PROCESS_WEBHOOK,
            payload: { inboxId: row.id, provider, type: envelope.type },
            dedupeKey: `webhook:${row.id}`,
            // Enough attempts to wait out a held, out-of-order event.
            maxAttempts: 8,
          });
        }
        return row;
      });

      if (stored === undefined) {
        return problem(reply, 404, 'unknown_sandbox', 'That sandbox has expired or never existed.');
      }
      if (stored.inserted) deps.onEventsCommitted();
      return { received: true, duplicate: !stored.inserted };
    });
    done();
  });
}
