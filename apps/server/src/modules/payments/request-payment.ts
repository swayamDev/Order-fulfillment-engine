import type { Job, Tx } from '@sethu/db';
import { markProcessed, type OutboxMessage } from '../outbox/index.ts';
import { appendOrderEvent, lockOrder, transitionOrder } from '../orders/index.ts';
import { PermanentJobError } from '../queue/index.ts';
import type { PaymentsClient } from './client.ts';

export const REQUEST_PAYMENT = 'payments.request';

/**
 * Consumer of order.inventory_reserved: ask the provider to charge the order,
 * then move it to payment_pending. The provider call carries an idempotency
 * key derived from the order, so if this transaction dies after the call (a
 * worker crash, a lost lease), the retry gets the same intent back instead of
 * charging again. The outcome arrives later, as webhooks.
 */
export function requestPayment(client: PaymentsClient) {
  return async (tx: Tx, job: Job): Promise<void> => {
    const message = job.payload as unknown as OutboxMessage;
    if (typeof message.messageId !== 'string' || typeof message.aggregateId !== 'string') {
      throw new PermanentJobError('payments.request: payload is not an outbox message');
    }
    if (!(await markProcessed(tx, REQUEST_PAYMENT, message.messageId, job.sandbox_id))) return;

    const order = await lockOrder(tx, message.aggregateId);
    if (order === undefined) throw new PermanentJobError(`Order ${message.aggregateId} not found`);
    if (order.state !== 'inventory_reserved') {
      await appendOrderEvent(tx, order, 'skipped', {
        consumer: REQUEST_PAYMENT,
        reason: `order is ${order.state}, not inventory_reserved`,
      });
      return;
    }

    const intent = await client.createIntent({
      sandboxId: order.sandbox_id,
      orderId: order.id,
      amountMinor: order.total_minor,
      currency: order.currency,
      idempotencyKey: `order:${order.id}:charge`,
    });
    await transitionOrder(tx, order, 'payment_pending', {
      cause: { by: REQUEST_PAYMENT, intentId: intent.id, provider: 'sim-payments' },
    });
  };
}
