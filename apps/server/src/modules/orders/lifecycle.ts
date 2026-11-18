import { assertTransition, type OrderState } from '@sethu/domain';
import type { Order, Tx } from '@sethu/db';
import { sql } from 'kysely';
import { publish } from '../outbox/index.ts';

/**
 * Appends to an order's event log. The caller must hold the order's row lock
 * (or have just created the order), which serialises seq numbers per order.
 */
export async function appendOrderEvent(
  tx: Tx,
  order: Pick<Order, 'id' | 'sandbox_id'>,
  kind: string,
  data: Record<string, unknown>,
): Promise<number> {
  const row = await tx
    .insertInto('order_events')
    .values({
      sandbox_id: order.sandbox_id,
      order_id: order.id,
      seq: sql<number>`(SELECT coalesce(max(seq), 0) + 1 FROM order_events WHERE order_id = ${order.id})`,
      kind,
      data,
    })
    .returning('seq')
    .executeTakeFirstOrThrow();
  return row.seq;
}

/** Locks an order for the rest of the transaction. Two workers cannot both hold it. */
export async function lockOrder(tx: Tx, orderId: string): Promise<Order | undefined> {
  return tx
    .selectFrom('orders')
    .selectAll()
    .where('id', '=', orderId)
    .forUpdate()
    .executeTakeFirst();
}

export interface TransitionOptions {
  /** Why it moved, shown in the timeline (for example the webhook that caused it). */
  readonly cause: Record<string, unknown>;
  readonly paymentCaptured?: boolean;
}

/**
 * Moves a locked order to a new state if the state machine allows it, bumps
 * its version, logs the transition, and publishes "order.<new state>" in the
 * same transaction.
 */
export async function transitionOrder(
  tx: Tx,
  order: Order,
  to: OrderState,
  options: TransitionOptions,
): Promise<Order> {
  const paymentCaptured = options.paymentCaptured ?? order.payment_captured;
  assertTransition(order.state, to, { paymentCaptured });
  const updated = await tx
    .updateTable('orders')
    .set({
      state: to,
      version: order.version + 1,
      payment_captured: paymentCaptured,
      updated_at: sql<Date>`now()`,
    })
    .where('id', '=', order.id)
    .where('version', '=', order.version)
    .returningAll()
    .executeTakeFirst();
  if (updated === undefined) {
    // Unreachable while the caller holds the row lock; kept as a guard.
    throw new Error(`Order ${order.id} changed underneath a locked transition`);
  }
  await appendOrderEvent(tx, order, 'transition', { from: order.state, to, ...options.cause });
  await publish(tx, {
    sandboxId: order.sandbox_id,
    topic: `order.${to}`,
    aggregateId: order.id,
    payload: { orderId: order.id, from: order.state, to },
  });
  return updated;
}
