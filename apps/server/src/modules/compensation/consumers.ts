import type { Job, Tx } from '@sethu/db';
import { releaseReservation, returnToStock } from '../inventory/index.ts';
import { markProcessed, type OutboxMessage } from '../outbox/index.ts';
import { appendOrderEvent, lockOrder, transitionOrder } from '../orders/index.ts';
import { requestRefund } from '../payments/index.ts';
import { PermanentJobError } from '../queue/index.ts';

export const COMPENSATE_PAYMENT_FAILED = 'compensation.payment-failed';
export const COMPENSATE_CANCELLED = 'compensation.cancelled';
export const COMPENSATE_SHIPMENT_FAILED = 'compensation.shipment-failed';

async function begin(tx: Tx, job: Job, consumer: string) {
  const message = job.payload as unknown as OutboxMessage;
  if (typeof message.messageId !== 'string' || typeof message.aggregateId !== 'string') {
    throw new PermanentJobError(`${consumer}: payload is not an outbox message`);
  }
  if (!(await markProcessed(tx, consumer, message.messageId, job.sandbox_id))) return undefined;
  const order = await lockOrder(tx, message.aggregateId);
  if (order === undefined) throw new PermanentJobError(`Order ${message.aggregateId} not found`);
  return order;
}

/**
 * On order.payment_failed: give the stock back and close the order as
 * cancelled. Nothing was charged, so there is nothing to refund.
 */
export async function compensatePaymentFailed(tx: Tx, job: Job): Promise<void> {
  const order = await begin(tx, job, COMPENSATE_PAYMENT_FAILED);
  if (order?.state !== 'payment_failed') return;
  const released = await releaseReservation(tx, order.id);
  await transitionOrder(tx, order, 'cancelled', {
    cause: { by: COMPENSATE_PAYMENT_FAILED, reason: 'payment failed', stockReleased: released },
  });
}

/**
 * On order.cancelled, however it got there: give back any stock still held or
 * already packed, and refund the payment if money was captured.
 */
export async function compensateCancelled(tx: Tx, job: Job): Promise<void> {
  const order = await begin(tx, job, COMPENSATE_CANCELLED);
  if (order === undefined) return;
  if (await releaseReservation(tx, order.id)) {
    await appendOrderEvent(tx, order, 'compensation', { action: 'stock_released' });
  }
  if (await returnToStock(tx, order.id)) {
    await appendOrderEvent(tx, order, 'compensation', { action: 'packed_stock_returned' });
  }
  if (order.payment_captured) {
    await requestRefund(tx, order, 'order cancelled after payment');
  }
}

/**
 * On order.shipment_failed: the courier returned the parcel. Put the units
 * back on the shelf and refund the customer; the refund webhook then moves
 * the order to refunded.
 */
export async function compensateShipmentFailed(tx: Tx, job: Job): Promise<void> {
  const order = await begin(tx, job, COMPENSATE_SHIPMENT_FAILED);
  if (order?.state !== 'shipment_failed') return;
  if (await returnToStock(tx, order.id)) {
    await appendOrderEvent(tx, order, 'compensation', { action: 'returned_parcel_restocked' });
  }
  await requestRefund(tx, order, 'shipment failed');
}
