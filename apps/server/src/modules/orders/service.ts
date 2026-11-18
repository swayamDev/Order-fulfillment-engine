import { createHash } from 'node:crypto';
import type { OrderView, PlaceOrderRequest } from '@sethu/contracts';
import { withSandbox, type Db, type Order, type Tx } from '@sethu/db';
import { publish } from '../outbox/index.ts';
import { appendOrderEvent } from './lifecycle.ts';

export class UnknownSkuError extends Error {
  readonly skus: string[];
  constructor(skus: string[]) {
    super(`Unknown SKU: ${skus.join(', ')}`);
    this.name = 'UnknownSkuError';
    this.skus = skus;
  }
}

export class IdempotencyConflictError extends Error {
  constructor() {
    super('This Idempotency-Key was already used with a different request body.');
    this.name = 'IdempotencyConflictError';
  }
}

export type PlaceOrderResult =
  | { readonly kind: 'created'; readonly order: OrderView }
  | { readonly kind: 'replayed'; readonly order: OrderView };

/** Hash of the request's meaning, independent of item order and JSON formatting. */
export function requestHash(request: PlaceOrderRequest): string {
  const canonical = [...request.items]
    .sort((a, b) => a.sku.localeCompare(b.sku))
    .map((item) => `${item.sku}:${item.quantity}`)
    .join(',');
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Places an order exactly once per (sandbox, Idempotency-Key). A retry with
 * the same key and body returns the original order; the same key with a
 * different body is rejected. Concurrent requests with one key are settled by
 * the unique index: ON CONFLICT DO NOTHING waits for the first transaction,
 * and every other request then reads and returns its order.
 */
export async function placeOrder(
  db: Db,
  sandboxId: string,
  key: string,
  request: PlaceOrderRequest,
): Promise<PlaceOrderResult> {
  const hash = requestHash(request);
  return withSandbox(db, sandboxId, async (tx) => {
    const existing = await findByKey(tx, key);
    if (existing !== undefined) return replay(tx, existing, hash);

    const skus = request.items.map((i) => i.sku);
    const products = await tx
      .selectFrom('products')
      .select(['sku', 'price_minor'])
      .where('sku', 'in', skus)
      .execute();
    const prices = new Map(products.map((p) => [p.sku, p.price_minor]));
    const unknown = skus.filter((sku) => !prices.has(sku));
    if (unknown.length > 0) throw new UnknownSkuError(unknown);

    const total = request.items.reduce((sum, i) => sum + (prices.get(i.sku) ?? 0) * i.quantity, 0);
    const order = await tx
      .insertInto('orders')
      .values({
        sandbox_id: sandboxId,
        idempotency_key: key,
        request_hash: hash,
        state: 'placed',
        total_minor: total,
      })
      .onConflict((oc) => oc.columns(['sandbox_id', 'idempotency_key']).doNothing())
      .returningAll()
      .executeTakeFirst();

    if (order === undefined) {
      // A concurrent request with the same key committed first.
      const winner = await findByKey(tx, key);
      if (winner === undefined) throw new Error('Idempotency key conflict without a winning order');
      return replay(tx, winner, hash);
    }

    await tx
      .insertInto('order_items')
      .values(
        request.items.map((item, line) => ({
          order_id: order.id,
          sandbox_id: sandboxId,
          line: line + 1,
          sku: item.sku,
          quantity: item.quantity,
          unit_price_minor: prices.get(item.sku) ?? 0,
        })),
      )
      .execute();
    await appendOrderEvent(tx, order, 'transition', {
      from: null,
      to: 'placed',
      via: 'api',
      idempotencyKey: key,
    });
    await publish(tx, {
      sandboxId,
      topic: 'order.placed',
      aggregateId: order.id,
      payload: { orderId: order.id, from: null, to: 'placed' },
    });
    return { kind: 'created', order: await view(tx, order) };
  });
}

export async function getOrder(
  db: Db,
  sandboxId: string,
  id: string,
): Promise<OrderView | undefined> {
  return withSandbox(db, sandboxId, async (tx) => {
    const order = await tx.selectFrom('orders').selectAll().where('id', '=', id).executeTakeFirst();
    return order === undefined ? undefined : view(tx, order);
  });
}

async function findByKey(tx: Tx, key: string): Promise<Order | undefined> {
  return tx.selectFrom('orders').selectAll().where('idempotency_key', '=', key).executeTakeFirst();
}

async function replay(tx: Tx, order: Order, hash: string): Promise<PlaceOrderResult> {
  if (order.request_hash !== hash) throw new IdempotencyConflictError();
  return { kind: 'replayed', order: await view(tx, order) };
}

async function view(tx: Tx, order: Order): Promise<OrderView> {
  const items = await tx
    .selectFrom('order_items')
    .innerJoin('products', (join) =>
      join
        .onRef('products.sku', '=', 'order_items.sku')
        .onRef('products.sandbox_id', '=', 'order_items.sandbox_id'),
    )
    .select([
      'order_items.sku',
      'products.name',
      'order_items.quantity',
      'order_items.unit_price_minor',
    ])
    .where('order_items.order_id', '=', order.id)
    .orderBy('order_items.line')
    .execute();
  const events = await tx
    .selectFrom('order_events')
    .select(['seq', 'kind', 'data', 'created_at'])
    .where('order_id', '=', order.id)
    .orderBy('seq')
    .execute();
  return {
    id: order.id,
    state: order.state,
    version: order.version,
    currency: order.currency,
    totalMinor: order.total_minor,
    paymentCaptured: order.payment_captured,
    idempotencyKey: order.idempotency_key,
    createdAt: order.created_at.toISOString(),
    updatedAt: order.updated_at.toISOString(),
    items: items.map((i) => ({
      sku: i.sku,
      name: i.name,
      quantity: i.quantity,
      unitPriceMinor: i.unit_price_minor,
    })),
    events: events.map((e) => ({
      seq: e.seq,
      kind: e.kind,
      data: e.data,
      at: e.created_at.toISOString(),
    })),
  };
}
