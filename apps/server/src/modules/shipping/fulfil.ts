import type { Job, Order, Tx } from '@sethu/db';
import type { OrderState } from '@sethu/domain';
import { consumeReservation } from '../inventory/index.ts';
import { markProcessed, type OutboxMessage } from '../outbox/index.ts';
import { appendOrderEvent, lockOrder, transitionOrder } from '../orders/index.ts';
import { PermanentJobError } from '../queue/index.ts';
import type { CourierClient } from './client.ts';

export const PACK_ORDER = 'fulfillment.pack';
export const SHIP_ORDER = 'fulfillment.ship';

/** Shared start of a fulfillment consumer: dedupe, lock, and check the state. */
async function begin(
  tx: Tx,
  job: Job,
  consumer: string,
  expected: OrderState,
): Promise<Order | undefined> {
  const message = job.payload as unknown as OutboxMessage;
  if (typeof message.messageId !== 'string' || typeof message.aggregateId !== 'string') {
    throw new PermanentJobError(`${consumer}: payload is not an outbox message`);
  }
  if (!(await markProcessed(tx, consumer, message.messageId, job.sandbox_id))) return undefined;
  const order = await lockOrder(tx, message.aggregateId);
  if (order === undefined) throw new PermanentJobError(`Order ${message.aggregateId} not found`);
  if (order.state !== expected) {
    await appendOrderEvent(tx, order, 'skipped', {
      consumer,
      reason: `order is ${order.state}, not ${expected}`,
    });
    return undefined;
  }
  return order;
}

/** On order.paid: the warehouse packs it. The reserved units leave the shelf. */
export async function packOrder(tx: Tx, job: Job): Promise<void> {
  const order = await begin(tx, job, PACK_ORDER, 'paid');
  if (order === undefined) return;
  await consumeReservation(tx, order.id);
  await transitionOrder(tx, order, 'packed', { cause: { by: PACK_ORDER } });
}

/**
 * On order.packed: book the courier. The booking carries a key derived from
 * the order, so a retry after a crash gets the same shipment. While the
 * courier is down the call throws and the job retries with backoff; once its
 * attempts run out it waits in the dead-letter queue for a replay.
 */
export function shipOrder(courier: CourierClient) {
  return async (tx: Tx, job: Job): Promise<void> => {
    const order = await begin(tx, job, SHIP_ORDER, 'packed');
    if (order === undefined) return;
    const shipment = await courier.book({
      sandboxId: order.sandbox_id,
      orderId: order.id,
      idempotencyKey: `order:${order.id}:ship`,
    });
    await tx
      .insertInto('shipments')
      .values({
        shipment_id: shipment.id,
        sandbox_id: order.sandbox_id,
        order_id: order.id,
        provider: 'sim-courier',
      })
      .onConflict((oc) => oc.column('shipment_id').doNothing())
      .execute();
    await transitionOrder(tx, order, 'shipped', {
      cause: { by: SHIP_ORDER, shipmentId: shipment.id, provider: 'sim-courier' },
    });
  };
}
