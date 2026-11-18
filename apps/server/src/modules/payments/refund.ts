import type { Job, Tx } from '@sethu/db';
import { appendOrderEvent, lockOrder } from '../orders/index.ts';
import { enqueue, PermanentJobError } from '../queue/index.ts';
import type { PaymentsClient } from './client.ts';

export const REFUND_PAYMENT = 'payments.refund';

/**
 * Queues a refund for an order's captured payment, once per payment. Called
 * by compensations (cancelled after capture, shipment failed, or a capture
 * that arrived after the order was cancelled).
 */
export async function requestRefund(
  tx: Tx,
  order: { id: string; sandbox_id: string },
  reason: string,
): Promise<boolean> {
  const payment = await tx
    .selectFrom('payments')
    .select(['intent_id', 'status'])
    .where('order_id', '=', order.id)
    .where('status', '=', 'captured')
    .executeTakeFirst();
  if (payment === undefined) return false;
  const queued = await enqueue(tx, {
    sandboxId: order.sandbox_id,
    queue: REFUND_PAYMENT,
    payload: { orderId: order.id, intentId: payment.intent_id, reason },
    dedupeKey: `refund:${payment.intent_id}`,
  });
  if (queued) {
    await appendOrderEvent(tx, order, 'compensation', {
      action: 'refund_requested',
      intentId: payment.intent_id,
      reason,
    });
  }
  return queued;
}

/**
 * Job handler: asks the provider to refund. The provider call is idempotent
 * per payment, so a retry after a crash cannot refund twice. The order moves
 * to refunded when the provider's payment.refunded webhook arrives, in
 * sequence like every other payment event.
 */
export function refundPayment(client: PaymentsClient) {
  return async (tx: Tx, job: Job): Promise<void> => {
    const { orderId, intentId } = job.payload as { orderId?: unknown; intentId?: unknown };
    if (typeof orderId !== 'string' || typeof intentId !== 'string') {
      throw new PermanentJobError('payments.refund: bad payload');
    }
    const order = await lockOrder(tx, orderId);
    if (order === undefined) throw new PermanentJobError(`Order ${orderId} not found`);
    await client.refund({ sandboxId: order.sandbox_id, intentId });
    await appendOrderEvent(tx, order, 'compensation', {
      action: 'refund_sent',
      intentId,
      provider: 'sim-payments',
    });
  };
}
