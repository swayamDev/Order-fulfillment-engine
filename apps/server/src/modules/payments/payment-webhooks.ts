import type { Tx } from '@sethu/db';
import { sql } from 'kysely';
import { z } from 'zod';
import { appendOrderEvent, lockOrder, transitionOrder } from '../orders/index.ts';
import { PermanentJobError, type JobOutcome } from '../queue/index.ts';
import { checkSequence, releaseNext, type InboxEventView } from '../webhooks/index.ts';
import { requestRefund } from './refund.ts';

const PaymentData = z.object({
  intent_id: z.string(),
  order_id: z.uuid(),
  sequence: z.number().int().min(1),
});

/**
 * Applies a payment provider webhook, strictly in the payment's own sequence
 * (see ../webhooks/sequencing.ts), under the order's row lock and then the
 * payment's.
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
  const verdict = await checkSequence({
    tx,
    order,
    event,
    note: base,
    subject: 'payment',
    sequence: data.sequence,
    lastApplied: payment.last_seq,
  });
  if (verdict.kind === 'done') return undefined;
  if (verdict.kind === 'defer') return verdict.outcome;

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
  if (outcome.kind === 'refund') {
    // The money was taken after the order was cancelled: record it and give it back.
    await tx
      .updateTable('orders')
      .set({ payment_captured: true, updated_at: sql<Date>`now()` })
      .where('id', '=', order.id)
      .execute();
    await requestRefund(tx, order, 'payment captured after the order was cancelled');
  }
  await releaseNext(tx, event.provider, 'intent_id', data.intent_id, data.sequence + 1);
  return undefined;
}

type Outcome =
  | {
      kind: 'apply';
      to: 'paid' | 'payment_failed' | 'refunded';
      paymentStatus: 'captured' | 'failed' | 'refunded';
    }
  | { kind: 'refund'; paymentStatus: 'captured' }
  | { kind: 'noted'; paymentStatus?: 'authorized' }
  | { kind: 'ignored'; reason: string; paymentStatus?: 'captured' | 'failed' };

function decide(state: string, type: string): Outcome {
  switch (type) {
    case 'payment.authorized':
      return state === 'payment_pending'
        ? { kind: 'noted', paymentStatus: 'authorized' }
        : { kind: 'ignored', reason: `order is already ${state}` };
    case 'payment.captured':
      if (state === 'payment_pending')
        return { kind: 'apply', to: 'paid', paymentStatus: 'captured' };
      if (state === 'cancelled') return { kind: 'refund', paymentStatus: 'captured' };
      return {
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
    case 'payment.refunded':
      return state === 'cancelled' || state === 'shipment_failed'
        ? { kind: 'apply', to: 'refunded', paymentStatus: 'refunded' }
        : {
            kind: 'ignored',
            reason: `order is ${state}; a refund only completes a cancelled or failed shipment`,
          };
    default:
      return { kind: 'ignored', reason: `unknown event type ${type}` };
  }
}
