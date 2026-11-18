import type { Job, Tx } from '@sethu/db';
import { sql } from 'kysely';
import { markProcessed, type OutboxMessage } from '../outbox/index.ts';
import { appendOrderEvent, lockOrder, transitionOrder } from '../orders/index.ts';
import { PermanentJobError } from '../queue/index.ts';

export const RESERVE_INVENTORY = 'inventory.reserve';

/**
 * Consumer of order.placed: reserve every line of the order, or none of them.
 *
 * Runs as sethu_app inside the order's sandbox. The order's row lock keeps two
 * deliveries of the same event from interleaving; locking stock rows in SKU
 * order means two orders for overlapping SKUs queue behind each other instead
 * of deadlocking. The CHECK (available >= 0) constraint is the last line of
 * defence against overselling.
 */
export async function reserveInventory(tx: Tx, job: Job): Promise<void> {
  const message = job.payload as unknown as OutboxMessage;
  if (typeof message.messageId !== 'string' || typeof message.aggregateId !== 'string') {
    throw new PermanentJobError('inventory.reserve: payload is not an outbox message');
  }
  if (!(await markProcessed(tx, RESERVE_INVENTORY, message.messageId, job.sandbox_id))) return;

  const order = await lockOrder(tx, message.aggregateId);
  if (order === undefined) throw new PermanentJobError(`Order ${message.aggregateId} not found`);
  if (order.state !== 'placed') {
    // Cancelled (or otherwise moved on) before we got to it: nothing to reserve.
    await appendOrderEvent(tx, order, 'skipped', {
      consumer: RESERVE_INVENTORY,
      reason: `order is ${order.state}, not placed`,
    });
    return;
  }

  const lines = await tx
    .selectFrom('order_items')
    .select(['sku', 'quantity'])
    .where('order_id', '=', order.id)
    .orderBy('sku')
    .execute();
  const stock = await tx
    .selectFrom('stock')
    .select(['sku', 'available'])
    .where(
      'sku',
      'in',
      lines.map((l) => l.sku),
    )
    .orderBy('sku')
    .forUpdate()
    .execute();
  const available = new Map(stock.map((s) => [s.sku, s.available]));

  const short = lines
    .filter((line) => (available.get(line.sku) ?? 0) < line.quantity)
    .map((line) => ({
      sku: line.sku,
      wanted: line.quantity,
      available: available.get(line.sku) ?? 0,
    }));
  if (short.length > 0) {
    await transitionOrder(tx, order, 'out_of_stock', { cause: { by: RESERVE_INVENTORY, short } });
    return;
  }

  for (const line of lines) {
    await tx
      .updateTable('stock')
      .set({
        available: sql<number>`available - ${line.quantity}`,
        reserved: sql<number>`reserved + ${line.quantity}`,
        updated_at: sql<Date>`now()`,
      })
      .where('sku', '=', line.sku)
      .execute();
  }
  await tx
    .insertInto('reservations')
    .values({ order_id: order.id, sandbox_id: order.sandbox_id, status: 'held' })
    .execute();
  await transitionOrder(tx, order, 'inventory_reserved', {
    cause: {
      by: RESERVE_INVENTORY,
      lines: lines.map((l) => ({ sku: l.sku, quantity: l.quantity })),
    },
  });
}
