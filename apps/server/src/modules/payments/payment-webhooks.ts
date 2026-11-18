import type { Order, Tx } from '@sethu/db';
import { sql } from 'kysely';
import { z } from 'zod';
import { appendOrderEvent, lockOrder, transitionOrder } from '../orders/index.ts';
import { deadLetter, PermanentJobError, retryLater, type JobOutcome } from '../queue/index.ts';
import type { InboxEventView } from '../webhooks/index.ts';

/** The longest an event may wait for an earlier one before it is dead-lettered. */
export const MAX_HOLD_MS = 10 * 60_000;

const PaymentData = z.object({
  intent_id: z.string(),
  order_id: z.uuid(),
  sequence: z.number().int().min(1),
});

/**
 * Applies a payment provider webhook, strictly in the payment's own sequence.
 *
 * Under the order's row lock (then the payment's), with `last` the highest
 * sequence applied so far:
 *   sequence <= last      already applied: ignored, recorded on the timeline
 *   sequence == last + 1  applied; any event held for last + 2 is released
 *   sequence >  last + 1  held: deferred with backoff, noted once on the
 *                         timeline, and dead-lettered as out_of_order_unresolved
 *                         after its attempts or MAX_HOLD_MS, whichever is first
 *
 * Waiting for the order lock also covers a webhook that overtakes our own
 * payment_pending transition: it waits for that commit, then proceeds.
 */
export async function applyPaymentWebhook(
  tx: Tx,
  event: InboxEventView,
): Promise<JobOutcome | undefined> {
  const parsed = PaymentData.safeParse(event.payload['data']);
  if (!parsed.success) {
    throw new PermanentJobError(`Payment webhook ${event.providerEventId} is missing its data`);
  }
  const data = parsed.data;

  const order = await lockOrder(tx, data.order_id);
  if (order === undefined) {
    throw new PermanentJobError(`Payment webhook ${event.providerEventId}: order not found`);
  }
  const payment = await tx
    .selectFrom('payments')
    .selectAll()
    .where('intent_id', '=', data.intent_id)
    .forUpdate()
    .executeTakeFirst();
  if (payment === undefined) {
    throw new PermanentJobError(`Payment webhook ${event.providerEventId}: unknown intent`);
  }

  const base = {
    provider: event.provider,
    type: event.type,
    eventId: event.providerEventId,
    intentId: data.intent_id,
    sequence: data.sequence,
    duplicatesSoFar: event.duplicateCount,
    simulated: event.payload['simulated'] === true,
  };
  const expected = payment.last_seq + 1;

  if (data.sequence < expected) {
    await appendOrderEvent(tx, order, 'webhook', {
      ...base,
      outcome: 'ignored',
      reason: `sequence ${data.sequence} was already applied (payment is at ${payment.last_seq})`,
    });
    return undefined;
  }

  if (data.sequence > expected) {
    return hold(tx, order, event, base, expected, payment.last_seq);
  }

  const outcome = decide(order.state, event.type);
  await appendOrderEvent(tx, order, 'webhook', {
    ...base,
    outcome: outcome.kind,
    ...(event.heldAt === null ? {} : { heldForMs: Date.now() - event.heldAt.getTime() }),
    ...(outcome.kind === 'ignored' ? { reason: outcome.reason } : {}),
  });
  await tx
    .updateTable('payments')
    .set({
      last_seq: data.sequence,
      updated_at: sql<Date>`now()`,
      ...(outcome.paymentStatus === undefined ? {} : { status: outcome.paymentStatus }),
    })
    .where('intent_id', '=', data.intent_id)
    .execute();
  if (outcome.kind === 'apply') {
    await transitionOrder(tx, order, outcome.to, {
      cause: { by: 'webhook', eventId: event.providerEventId, type: event.type },
      ...(outcome.to === 'paid' ? { paymentCaptured: true } : {}),
    });
  }
  await releaseNext(tx, data.intent_id, data.sequence + 1);
  return undefined;
}

async function hold(
  tx: Tx,
  order: Order,
  event: InboxEventView,
  base: Record<string, unknown>,
  expected: number,
  lastApplied: number,
): Promise<JobOutcome> {
  const heldSince = event.heldAt ?? new Date();
  const heldMs = Date.now() - Math.min(heldSince.getTime(), event.receivedAt.getTime());
  const waiting = `${event.type} is sequence ${String(base['sequence'])} and needs sequence ${expected} first (payment has applied up to ${lastApplied})`;

  if (heldMs > MAX_HOLD_MS) {
    const reason = `out_of_order_unresolved: ${waiting}; held ${Math.round(heldMs / 60_000)} min, longer than the ${MAX_HOLD_MS / 60_000} min limit`;
    await appendOrderEvent(tx, order, 'webhook', { ...base, outcome: 'dead_lettered', reason });
    return deadLetter(reason);
  }
  if (event.heldAt === null) {
    await tx
      .updateTable('webhook_inbox')
      .set({ held_at: sql<Date>`now()` })
      .where('id', '=', event.id)
      .execute();
    await appendOrderEvent(tx, order, 'webhook', {
      ...base,
      outcome: 'held',
      reason: `waiting for sequence ${expected}`,
    });
  }
  return retryLater(`out_of_order_unresolved: ${waiting}`);
}

/** Wakes the held event for `sequence` now, instead of after its backoff. */
async function releaseNext(tx: Tx, intentId: string, sequence: number): Promise<void> {
  await tx
    .updateTable('jobs')
    .set({ run_at: sql<Date>`now()`, updated_at: sql<Date>`now()` })
    .where('status', '=', 'queued')
    .where(
      'dedupe_key',
      'in',
      tx
        .selectFrom('webhook_inbox')
        .select(sql<string>`'webhook:' || id`.as('key'))
        .where('held_at', 'is not', null)
        .where('processed_at', 'is', null)
        .where(sql<string>`payload->'data'->>'intent_id'`, '=', intentId)
        .where(sql<string>`payload->'data'->>'sequence'`, '=', String(sequence)),
    )
    .execute();
}

type Outcome =
  | { kind: 'apply'; to: 'paid' | 'payment_failed'; paymentStatus: 'captured' | 'failed' }
  | { kind: 'noted'; paymentStatus?: 'authorized' }
  | { kind: 'ignored'; reason: string; paymentStatus?: 'captured' | 'failed' };

function decide(state: string, type: string): Outcome {
  switch (type) {
    case 'payment.authorized':
      return state === 'payment_pending'
        ? { kind: 'noted', paymentStatus: 'authorized' }
        : { kind: 'ignored', reason: `order is already ${state}` };
    case 'payment.captured':
      return state === 'payment_pending'
        ? { kind: 'apply', to: 'paid', paymentStatus: 'captured' }
        : {
            kind: 'ignored',
            reason: `order is ${state}, not payment_pending`,
            paymentStatus: 'captured',
          };
    case 'payment.failed':
      return state === 'payment_pending'
        ? { kind: 'apply', to: 'payment_failed', paymentStatus: 'failed' }
        : {
            kind: 'ignored',
            reason: `order is ${state}, not payment_pending`,
            paymentStatus: 'failed',
          };
    default:
      return { kind: 'ignored', reason: `unknown event type ${type}` };
  }
}
