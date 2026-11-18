// SIMULATED payment provider. Not a real payment system and never touches
// money. It stands in for a third party so that Sethu's payment path (an
// idempotent API call, then signed webhooks arriving later) is exercised over
// real HTTP. Everything it sends is labelled simulated.

import { randomUUID } from 'node:crypto';
import { withSandbox, type Db, type Job, type Tx } from '@sethu/db';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import { problem } from '../../http/problem.ts';
import { readChaos } from '../chaos/index.ts';
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
        const outcome = await scheduleOutcome(tx, config, created);
        await tx
          .updateTable('sim_payment_intents')
          .set({ status: outcome.status, next_sequence: outcome.nextSequence })
          .where('id', '=', created.id)
          .execute();
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

  // Refund a captured payment. Idempotent: refunding again answers with the
  // same refund. The refund webhook takes the payment's next sequence number.
  app.post('/sim/payments/v1/intents/:id/refunds', async (request, reply) => {
    reply.header('x-sethu-simulated', 'true');
    if (request.headers.authorization !== `Bearer ${config.apiKey}`) {
      return problem(reply, 401, 'unauthorized', 'Simulated provider: bad API key.');
    }
    const { id } = request.params as { id: string };
    const body = RefundIntent.parse(request.body);

    const result = await withSandbox(db, body.sandbox_id, async (tx) => {
      const intent = await tx
        .selectFrom('sim_payment_intents')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (intent === undefined) return { kind: 'not_found' as const };
      if (intent.status === 'refunded') return { kind: 'replayed' as const };
      if (intent.status !== 'captured')
        return { kind: 'not_captured' as const, status: intent.status };

      const chaos = await readChaos(tx);
      await enqueueDelivery(
        tx,
        intent.sandbox_id,
        buildEvent(intent, 'payment.refunded', intent.next_sequence),
        config.delayMs + chaos.paymentsExtraDelayMs,
        0,
      );
      await tx
        .updateTable('sim_payment_intents')
        .set({
          status: 'refunded',
          refunded_at: sql<Date>`now()`,
          next_sequence: intent.next_sequence + 1,
          updated_at: sql<Date>`now()`,
        })
        .where('id', '=', id)
        .execute();
      return { kind: 'created' as const };
    });

    switch (result.kind) {
      case 'not_found':
        return problem(reply, 404, 'not_found', 'Simulated provider: no such payment.');
      case 'not_captured':
        return problem(
          reply,
          409,
          'not_captured',
          `Simulated provider: payment is ${result.status}.`,
        );
      case 'replayed':
        return reply.code(200).send({ intent_id: id, status: 'refunded', simulated: true });
      case 'created':
        onJobsQueued();
        return reply.code(201).send({ intent_id: id, status: 'refunded', simulated: true });
    }
  });
}

const RefundIntent = z.object({ sandbox_id: z.uuid() });

interface IntentFacts {
  id: string;
  sandbox_id: string;
  order_id: string;
  amount_minor: number;
  currency: string;
}

function buildEvent(intent: IntentFacts, type: string, sequence: number) {
  return {
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
      sequence,
    },
  };
}

async function enqueueDelivery(
  tx: Tx,
  sandboxId: string,
  envelope: ReturnType<typeof buildEvent>,
  delayMs: number,
  copy: number,
): Promise<void> {
  await enqueue(tx, {
    sandboxId,
    queue: DELIVER_SIM_PAYMENT_WEBHOOK,
    payload: { envelope },
    dedupeKey: `sim-deliver:${envelope.id}:${copy}`,
    delayMs,
    maxAttempts: 8,
  });
}

/**
 * Queues the webhooks this payment will produce. Normally payment.authorized
 * (sequence 1) then payment.captured (sequence 2). The sandbox's chaos
 * settings, read in the same transaction, can make the provider decline,
 * deliver twice, deliver in reverse, lose the first event, or wait longer.
 */
async function scheduleOutcome(
  tx: Tx,
  config: SimPaymentsConfig,
  intent: IntentFacts,
): Promise<{ status: 'captured' | 'failed'; nextSequence: number }> {
  const chaos = await readChaos(tx);
  const types = chaos.paymentsDecline
    ? ['payment.failed']
    : ['payment.authorized', 'payment.captured'];
  const events = types.map((type, i) => buildEvent(intent, type, i + 1));

  const delivered = chaos.paymentsDropFirst ? events.slice(1) : events;
  const ordered = chaos.paymentsReverseOrder ? [...delivered].reverse() : delivered;
  const copies = chaos.paymentsDuplicate ? 2 : 1;
  const gap = config.delayMs + chaos.paymentsExtraDelayMs;

  for (const [slot, envelope] of ordered.entries()) {
    for (let copy = 0; copy < copies; copy++) {
      // Slots at least 2 ms apart so deliveries are claimed in the intended order.
      await enqueueDelivery(
        tx,
        intent.sandbox_id,
        envelope,
        gap * (slot + 1) + slot * 2 + copy,
        copy,
      );
    }
  }
  return {
    status: chaos.paymentsDecline ? 'failed' : 'captured',
    nextSequence: events.length + 1,
  };
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
