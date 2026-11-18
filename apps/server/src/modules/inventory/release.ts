import type { Tx } from '@sethu/db';
import { sql } from 'kysely';

/**
 * Returns an order's held stock to the shelf. Idempotent: only a reservation
 * still in "held" is released, so running this twice changes nothing.
 * Returns whether anything was released.
 */
export async function releaseReservation(tx: Tx, orderId: string): Promise<boolean> {
  const released = await tx
    .updateTable('reservations')
    .set({ status: 'released', updated_at: sql<Date>`now()` })
    .where('order_id', '=', orderId)
    .where('status', '=', 'held')
    .returning('order_id')
    .executeTakeFirst();
  if (released === undefined) return false;

  const lines = await tx
    .selectFrom('order_items')
    .select(['sku', 'quantity'])
    .where('order_id', '=', orderId)
    .orderBy('sku')
    .execute();
  for (const line of lines) {
    await tx
      .updateTable('stock')
      .set({
        available: sql<number>`available + ${line.quantity}`,
        reserved: sql<number>`reserved - ${line.quantity}`,
        updated_at: sql<Date>`now()`,
      })
      .where('sku', '=', line.sku)
      .execute();
  }
  return true;
}
