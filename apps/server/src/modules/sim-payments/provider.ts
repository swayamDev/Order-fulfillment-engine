// SIMULATED payment provider. Not a real payment system and never touches
// money. It stands in for a third party so that Sethu's payment path (an
// idempotent API call, then signed webhooks arriving later) is exercised over
// real HTTP. Everything it sends is labelled simulated.

import { randomUUID } from 'node:crypto';
import { withSandbox, type Db, type Job, type Tx } from '@sethu/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { problem } from '../../http/problem.ts';
import { enqueue, PermanentJobError } from '../queue/index.ts';
import { signatureHeader, SIGNATURE_HEADER } from '../webhooks/index.ts';

export const SIM_PAYMENTS = 'sim-payments';
export const DELIVER_SIM_PAYMENT_WEBHOOK = 'sim-payments.deliver';

export interface SimPaymentsConfig {
  /** Bearer key the payments module must present, like a provider secret key. */
  readonly apiKey: string;
  /** Secret the provider signs webhooks with. */
  readonly signingSecret: string;
  /** Where to deliver webhooks. A function so tests can bind to a random port. */
  readonly webhookUrl: () => string;
  /** Gap between successive webhooks for one payment. */
  readonly delayMs: number;
}

const CreateIntent = z.object({
  sandbox_id: z.uuid(),
  order_id: z.uuid(),
  amount_minor: z.number().int().positive(),
  currency: z.string().length(3),
});

export interface IntentResponse {
  id: string;
  status: 'processing';
  order_id: string;
  amount_minor: number;
  currency: string;
  simulated: true;
}

const DeliveryPayload = z.object({
  envelope: z.object({
    id: z.string(),
    type: z.string(),
    created: z.number(),
    sandbox_id: z.uuid(),
    simulated: z.literal(true),
    data: z.record(z.string(), z.unknown()),
  }),
});

/** The provider's public API: POST /sim/payments/v1/intents. */
export function simPaymentsRoutes(
  app: FastifyInstance,
  db: Db,
  config: SimPaymentsConfig,
  onJobsQueued: () => void,
): void {
  app.post('/sim/payments/v1/intents', async (request, reply) => {
    reply.header('x-sethu-simulated', 'true');
    if (request.headers.authorization !== `Bearer ${config.apiKey}`) {
      return problem(reply, 401, 'unauthorized', 'Simulated provider: bad API key.');
    }
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 8) {
      return problem(reply, 400, 'idempotency_key_required', 'Simulated provider needs a key.');
    }
    const body = CreateIntent.parse(request.body);

    const result = await withSandbox(db, body.sandbox_id, async (tx) => {
      const created = await tx
        .insertInto('sim_payment_intents')
        .values({
          id: `pi_sim_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
          sandbox_id: body.sandbox_id,
          order_id: body.order_id,
          idempotency_key: key,
          amount_minor: body.amount_minor,
          currency: body.currency,
          status: 'captured',
        })
        .onConflict((oc) => oc.columns(['sandbox_id', 'idempotency_key']).doNothing())
        .returningAll()
        .executeTakeFirst();
      if (created !== undefined) {
        await scheduleOutcome(tx, config, created);
        return { intent: created, replayed: false };
      }
      const existing = await tx
        .selectFrom('sim_payment_intents')
        .selectAll()
        .where('idempotency_key', '=', key)
        .executeTakeFirstOrThrow();
      return { intent: existing, replayed: true };
    });

    if (!result.replayed) onJobsQueued();
    const response: IntentResponse = {
      id: result.intent.id,
      status: 'processing',
      order_id: result.intent.order_id,
      amount_minor: result.intent.amount_minor,
      currency: result.intent.currency,
      simulated: true,
    };
    return reply.code(result.replayed ? 200 : 201).send(response);
  });
}

/**
 * Queues the webhooks this payment will produce. Phase 1 always succeeds:
 * payment.authorized, then payment.captured. The chaos panel will later
 * change outcomes, order, duplication and timing here.
 */
async function scheduleOutcome(
  tx: Tx,
  config: SimPaymentsConfig,
  intent: {
    id: string;
    sandbox_id: string;
    order_id: string;
    amount_minor: number;
    currency: string;
  },
): Promise<void> {
  const types = ['payment.authorized', 'payment.captured'];
  for (const [i, type] of types.entries()) {
    const envelope = {
      id: `evt_sim_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
      type,
      created: Math.floor(Date.now() / 1000),
      sandbox_id: intent.sandbox_id,
      simulated: true as const,
      data: {
        intent_id: intent.id,
        order_id: intent.order_id,
        amount_minor: intent.amount_minor,
        currency: intent.currency,
        sequence: i + 1,
      },
    };
    await enqueue(tx, {
      sandboxId: intent.sandbox_id,
      queue: DELIVER_SIM_PAYMENT_WEBHOOK,
      payload: { envelope },
      dedupeKey: `sim-deliver:${envelope.id}`,
      // At least 1 ms apart so they are claimed in order even with no delay.
      delayMs: config.delayMs * (i + 1) + i,
      maxAttempts: 8,
    });
  }
}

/** Job handler: POST one signed webhook. A non-2xx answer throws, so the queue retries with backoff. */
export function deliverSimPaymentWebhook(config: SimPaymentsConfig) {
  return async (_tx: Tx, job: Job): Promise<void> => {
    const parsed = DeliveryPayload.safeParse(job.payload);
    if (!parsed.success) throw new PermanentJobError('sim-payments.deliver: bad payload');
    const body = JSON.stringify(parsed.data.envelope);
    const response = await fetch(config.webhookUrl(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [SIGNATURE_HEADER]: signatureHeader(
          [config.signingSecret],
          Math.floor(Date.now() / 1000),
          body,
        ),
      },
      body,
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      throw new Error(`Webhook endpoint answered ${response.status}`);
    }
  };
}
