import type { Tx } from '@sethu/db';
import { z } from 'zod';
import { appendOrderEvent, lockOrder, transitionOrder } from '../orders/index.ts';
import { PermanentJobError } from '../queue/index.ts';
import type { InboxEventView } from '../webhooks/index.ts';

const PaymentData = z.object({
  intent_id: z.string(),
  order_id: z.uuid(),
});

/**
 * Applies a payment provider webhook to its order, under the order's row lock.
 * Waiting for that lock also covers a webhook that overtakes us: if the
 * provider answers before our payment_pending transition commits, this waits
 * for that commit and then sees payment_pending.
 *
 * Every webhook lands in the order's timeline, including ones that change
 * nothing, so the console can show exactly what arrived and why it was ignored.
 */
export async function applyPaymentWebhook(tx: Tx, event: InboxEventView): Promise<void> {
  const data = PaymentData.safeParse(event.payload['data']);
  if (!data.success)
    throw new PermanentJobError(`Payment webhook ${event.providerEventId} has no order`);

  const order = await lockOrder(tx, data.data.order_id);
  if (order === undefined) {
    throw new PermanentJobError(`Payment webhook ${event.providerEventId}: order not found`);
  }

  const outcome = decide(order.state, event.type);
  await appendOrderEvent(tx, order, 'webhook', {
    provider: event.provider,
    type: event.type,
    eventId: event.providerEventId,
    intentId: data.data.intent_id,
    duplicatesSoFar: event.duplicateCount,
    simulated: event.payload['simulated'] === true,
    outcome: outcome.kind,
    ...(outcome.kind === 'ignored' ? { reason: outcome.reason } : {}),
  });

  if (outcome.kind === 'apply') {
    await transitionOrder(tx, order, outcome.to, {
      cause: { by: 'webhook', eventId: event.providerEventId, type: event.type },
      ...(outcome.to === 'paid' ? { paymentCaptured: true } : {}),
    });
  }
}

type Outcome =
  | { kind: 'apply'; to: 'paid' | 'payment_failed' }
  | { kind: 'noted' }
  | { kind: 'ignored'; reason: string };

function decide(state: string, type: string): Outcome {
  switch (type) {
    case 'payment.authorized':
      return state === 'payment_pending'
        ? { kind: 'noted' }
        : { kind: 'ignored', reason: `order is already ${state}` };
    case 'payment.captured':
      return state === 'payment_pending'
        ? { kind: 'apply', to: 'paid' }
        : { kind: 'ignored', reason: `order is ${state}, not payment_pending` };
    case 'payment.failed':
      return state === 'payment_pending'
        ? { kind: 'apply', to: 'payment_failed' }
        : { kind: 'ignored', reason: `order is ${state}, not payment_pending` };
    default:
      return { kind: 'ignored', reason: `unknown event type ${type}` };
  }
}
