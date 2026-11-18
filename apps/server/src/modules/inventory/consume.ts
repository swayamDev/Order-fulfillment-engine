import type { Tx } from '@sethu/db';
import { sql } from 'kysely';

async function lines(tx: Tx, orderId: string) {
  return tx
    .selectFrom('order_items')
    .select(['sku', 'quantity'])
    .where('order_id', '=', orderId)
    .orderBy('sku')
    .execute();
}

/**
 * The order was packed: its reserved units have left the shelf. Moves the
 * reservation from held to consumed and takes the units out of `reserved`
 * (they were already out of `available`). Idempotent.
 */
export async function consumeReservation(tx: Tx, orderId: string): Promise<boolean> {
  const consumed = await tx
    .updateTable('reservations')
    .set({ status: 'consumed', updated_at: sql<Date>`now()` })
    .where('order_id', '=', orderId)
    .where('status', '=', 'held')
    .returning('order_id')
    .executeTakeFirst();
  if (consumed === undefined) return false;
  for (const line of await lines(tx, orderId)) {
    await tx
      .updateTable('stock')
      .set({
        reserved: sql<number>`reserved - ${line.quantity}`,
        updated_at: sql<Date>`now()`,
      })
      .where('sku', '=', line.sku)
      .execute();
  }
  return true;
}

/**
 * Packed units came back (the order was cancelled before shipping, or the
 * courier failed and returned the parcel): put them back on the shelf.
 * Idempotent: only a consumed reservation is returned.
 */
export async function returnToStock(tx: Tx, orderId: string): Promise<boolean> {
  const returned = await tx
    .updateTable('reservations')
    .set({ status: 'returned', updated_at: sql<Date>`now()` })
    .where('order_id', '=', orderId)
    .where('status', '=', 'consumed')
    .returning('order_id')
    .executeTakeFirst();
  if (returned === undefined) return false;
  for (const line of await lines(tx, orderId)) {
    await tx
      .updateTable('stock')
      .set({
        available: sql<number>`available + ${line.quantity}`,
        updated_at: sql<Date>`now()`,
      })
      .where('sku', '=', line.sku)
      .execute();
  }
  return true;
}
