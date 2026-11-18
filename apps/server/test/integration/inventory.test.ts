import type { OrderView } from '@sethu/contracts';
import { withSandbox } from '@sethu/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEngine, drain, HANDLERS, type Engine } from '../../src/engine.ts';
import { Worker } from '../../src/modules/queue/index.ts';
import { consoleJson, newSandbox, startHarness, type Harness } from './harness.ts';

let h: Harness;
let engine: Engine;

beforeAll(async () => {
  h = await startHarness();
  engine = createEngine(h.db, 4);
});

afterAll(async () => {
  await h.close();
});

async function place(cookie: string, key: string, items: { sku: string; quantity: number }[]) {
  const response = await h.app.inject({
    method: 'POST',
    url: '/v1/orders',
    headers: { ...consoleJson, cookie, 'idempotency-key': key },
    payload: { items },
  });
  return response.json<OrderView>();
}

async function snapshot(sandboxId: string, orderId?: string) {
  return withSandbox(h.owner, sandboxId, async (tx) => ({
    orders: await tx
      .selectFrom('orders')
      .select(['id', 'state', 'version'])
      .$if(orderId !== undefined, (q) => q.where('id', '=', orderId ?? ''))
      .execute(),
    stock: Object.fromEntries(
      (await tx.selectFrom('stock').select(['sku', 'available', 'reserved']).execute()).map((s) => [
        s.sku,
        { available: s.available, reserved: s.reserved },
      ]),
    ),
    reservations: await tx.selectFrom('reservations').select(['order_id', 'status']).execute(),
    events: await tx
      .selectFrom('order_events')
      .select(['order_id', 'seq', 'kind', 'data'])
      .orderBy('seq')
      .execute(),
    published: await tx.selectFrom('outbox').select(['topic', 'aggregate_id']).execute(),
  }));
}

describe('inventory reservation', () => {
  it('reserves stock and moves the order to inventory_reserved', async () => {
    const { cookie, id: sandbox } = await newSandbox(h.app);
    const order = await place(cookie, 'reserve-0001', [
      { sku: 'TEA-ASSAM-250', quantity: 2 },
      { sku: 'POT-CLAY-06', quantity: 1 },
    ]);
    await drain(engine);

    const s = await snapshot(sandbox);
    expect(s.orders).toEqual([{ id: order.id, state: 'inventory_reserved', version: 2 }]);
    expect(s.stock['TEA-ASSAM-250']).toEqual({ available: 38, reserved: 2 });
    expect(s.stock['POT-CLAY-06']).toEqual({ available: 5, reserved: 1 });
    expect(s.reservations).toEqual([{ order_id: order.id, status: 'held' }]);
    expect(s.events.map((e) => [e.seq, e.data['to']])).toEqual([
      [1, 'placed'],
      [2, 'inventory_reserved'],
    ]);
    expect(s.published.map((p) => p.topic).sort()).toEqual([
      'order.inventory_reserved',
      'order.placed',
    ]);
  });

  it('does nothing when the same event is delivered again', async () => {
    const { cookie, id: sandbox } = await newSandbox(h.app);
    await place(cookie, 'redeliver-0001', [{ sku: 'STRAINER-STEEL', quantity: 4 }]);
    await drain(engine);
    // Redeliver every job in this sandbox.
    await withSandbox(h.owner, sandbox, (tx) =>
      tx.updateTable('jobs').set({ status: 'queued', finished_at: null }).execute(),
    );
    await drain(engine);

    const s = await snapshot(sandbox);
    expect(s.stock['STRAINER-STEEL']).toEqual({ available: 56, reserved: 4 });
    expect(s.orders[0]?.version).toBe(2);
  });

  it('never oversells when ten orders race for two kettles', async () => {
    const { cookie, id: sandbox } = await newSandbox(h.app);
    for (let i = 0; i < 10; i++) {
      await place(cookie, `kettle-rush-${String(i).padStart(4, '0')}`, [
        { sku: 'KETTLE-BRASS', quantity: 1 },
      ]);
    }
    // Five workers taking one job at a time, so the reservations really race.
    while ((await engine.relay.runOnce()) > 0) {
      /* publish every order.placed */
    }
    const racers = Array.from(
      { length: 5 },
      (_, i) => new Worker({ db: h.db, id: `kettle-racer-${i}`, handlers: HANDLERS, batchSize: 1 }),
    );
    await Promise.all(
      racers.map(async (worker) => {
        while ((await worker.runOnce()) > 0) {
          /* keep going */
        }
      }),
    );

    const s = await snapshot(sandbox);
    const states = s.orders.map((o) => o.state).sort();
    expect(states.filter((x) => x === 'inventory_reserved')).toHaveLength(2);
    expect(states.filter((x) => x === 'out_of_stock')).toHaveLength(8);
    expect(s.stock['KETTLE-BRASS']).toEqual({ available: 0, reserved: 2 });
  });

  it('reserves nothing when any line is short', async () => {
    const { cookie, id: sandbox } = await newSandbox(h.app);
    const order = await place(cookie, 'partial-0001', [
      { sku: 'TEA-ASSAM-250', quantity: 1 },
      { sku: 'KETTLE-BRASS', quantity: 3 },
    ]);
    await drain(engine);

    const s = await snapshot(sandbox, order.id);
    expect(s.orders[0]?.state).toBe('out_of_stock');
    expect(s.stock['TEA-ASSAM-250']).toEqual({ available: 40, reserved: 0 });
    expect(s.reservations).toEqual([]);
    const last = s.events.at(-1);
    expect(last?.data['short']).toEqual([{ sku: 'KETTLE-BRASS', wanted: 3, available: 2 }]);
  });

  it('skips an order that was cancelled before the reservation ran', async () => {
    const { cookie, id: sandbox } = await newSandbox(h.app);
    const order = await place(cookie, 'cancelled-0001', [{ sku: 'MUG-STONE-01', quantity: 1 }]);
    await withSandbox(h.owner, sandbox, (tx) =>
      tx.updateTable('orders').set({ state: 'cancelled' }).where('id', '=', order.id).execute(),
    );
    await drain(engine);

    const s = await snapshot(sandbox, order.id);
    expect(s.orders[0]?.state).toBe('cancelled');
    expect(s.stock['MUG-STONE-01']).toEqual({ available: 18, reserved: 0 });
    expect(s.events.at(-1)).toMatchObject({ kind: 'skipped' });
  });
});
