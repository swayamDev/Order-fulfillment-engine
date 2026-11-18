import type { OrderView } from '@sethu/contracts';
import { withSandbox, type Db } from '@sethu/db';
import { appDb, ownerDb } from '@sethu/db/testing';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { createEngine, drain, type Engine } from '../../src/engine.ts';
import { httpPaymentsClient } from '../../src/modules/payments/index.ts';
import { httpCourierClient } from '../../src/modules/shipping/index.ts';
import type { SimCourierConfig } from '../../src/modules/sim-courier/index.ts';
import type { SimPaymentsConfig } from '../../src/modules/sim-payments/index.ts';
import { consoleJson, newSandbox, TEST_CONFIG } from './harness.ts';

const PAY_SECRET = 'test-sim-payments-secret-000000000000';
const SHIP_SECRET = 'test-sim-courier-secret-0000000000000';
const PAY_KEY = 'sk_sim_test_000000000000';
const SHIP_KEY = 'ck_sim_test_000000000000';

let app: FastifyInstance;
let db: Db;
let owner: Db;
let baseUrl = '';

const simPayments: SimPaymentsConfig = {
  apiKey: PAY_KEY,
  signingSecret: PAY_SECRET,
  webhookUrl: () => `${baseUrl}/v1/webhooks/sim-payments`,
  delayMs: 0,
};
const simCourier: SimCourierConfig = {
  apiKey: SHIP_KEY,
  signingSecret: SHIP_SECRET,
  webhookUrl: () => `${baseUrl}/v1/webhooks/sim-courier`,
  delayMs: 0,
};
const payments = httpPaymentsClient({ baseUrl: () => `${baseUrl}/sim/payments`, apiKey: PAY_KEY });
const courier = httpCourierClient({ baseUrl: () => `${baseUrl}/sim/courier`, apiKey: SHIP_KEY });

const engine = (random?: () => number): Engine =>
  createEngine(db, {
    payments,
    courier,
    simPayments,
    simCourier,
    workerCount: 2,
    ...(random === undefined ? {} : { worker: { random } }),
  });

beforeAll(async () => {
  db = appDb(16);
  owner = ownerDb();
  app = await buildApp({
    config: TEST_CONFIG,
    db,
    simPayments,
    simCourier,
    webhookSecrets: new Map([
      ['sim-payments', [PAY_SECRET]],
      ['sim-courier', [SHIP_SECRET]],
    ]),
  });
  baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
});

afterAll(async () => {
  await app.close();
  await db.destroy();
  await owner.destroy();
});

async function sandbox(chaos: Record<string, unknown> = {}) {
  const s = await newSandbox(app);
  if (Object.keys(chaos).length > 0) await setChaos(s.cookie, chaos);
  return s;
}

async function setChaos(cookie: string, chaos: Record<string, unknown>) {
  const response = await app.inject({
    method: 'PATCH',
    url: '/v1/chaos',
    headers: { ...consoleJson, cookie },
    payload: chaos,
  });
  expect(response.statusCode).toBe(200);
}

async function place(cookie: string, key: string) {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/orders',
    headers: { ...consoleJson, cookie, 'idempotency-key': key },
    payload: { items: [{ sku: 'POT-CLAY-06', quantity: 2 }] },
  });
  return response.json<OrderView>().id;
}

async function getOrder(cookie: string, id: string) {
  const response = await app.inject({
    method: 'GET',
    url: `/v1/orders/${id}`,
    headers: { cookie },
  });
  return response.json<OrderView>();
}

async function drainUntil(e: Engine, cookie: string, id: string, done: (o: OrderView) => boolean) {
  const deadline = Date.now() + 8_000;
  for (;;) {
    await drain(e);
    const o = await getOrder(cookie, id);
    if (done(o)) return o;
    if (Date.now() > deadline) throw new Error(`Order stuck in ${o.state}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const transitions = (o: OrderView) =>
  o.events.filter((e) => e.kind === 'transition').map((e) => e.data['to']);

async function facts(sandboxId: string) {
  return withSandbox(owner, sandboxId, async (tx) => ({
    clayPot: await tx
      .selectFrom('stock')
      .select(['available', 'reserved'])
      .where('sku', '=', 'POT-CLAY-06')
      .executeTakeFirstOrThrow(),
    reservations: await tx.selectFrom('reservations').select('status').execute(),
    shipments: await tx.selectFrom('shipments').select(['status', 'last_seq']).execute(),
    shipJobs: await tx
      .selectFrom('jobs')
      .selectAll()
      .where('queue', '=', 'fulfillment.ship')
      .execute(),
  }));
}

describe('fulfillment: packing and shipping', () => {
  it('takes an order all the way from placed to delivered', async () => {
    const s = await sandbox();
    const id = await place(s.cookie, 'ship-happy-0001');
    const o = await drainUntil(engine(), s.cookie, id, (x) => x.state === 'delivered');

    expect(transitions(o)).toEqual([
      'placed',
      'inventory_reserved',
      'payment_pending',
      'paid',
      'packed',
      'shipped',
      'in_transit',
      'delivered',
    ]);
    const f = await facts(s.id);
    // Two pots left the warehouse for good.
    expect(f.clayPot).toEqual({ available: 4, reserved: 0 });
    expect(f.reservations).toEqual([{ status: 'consumed' }]);
    expect(f.shipments).toEqual([{ status: 'delivered', last_seq: 2 }]);
  });

  it('courier down: booking retries with backoff and recovers when the courier is back', async () => {
    const s = await sandbox({ courierDown: true });
    const id = await place(s.cookie, 'ship-down-0001');
    const e = engine();
    await drainUntil(e, s.cookie, id, (x) => x.state === 'packed');
    await drain(e);

    let f = await facts(s.id);
    expect(f.shipJobs[0]?.status).toBe('queued');
    expect(f.shipJobs[0]?.last_error).toContain('Courier answered 503');
    expect((await getOrder(s.cookie, id)).state).toBe('packed');

    // The courier comes back; the next retry (made due now) books the shipment.
    await setChaos(s.cookie, { courierDown: false });
    await withSandbox(owner, s.id, (tx) =>
      tx
        .updateTable('jobs')
        .set({ run_at: sql<Date>`now()` })
        .where('queue', '=', 'fulfillment.ship')
        .execute(),
    );
    const o = await drainUntil(e, s.cookie, id, (x) => x.state === 'delivered');
    expect(o.state).toBe('delivered');
    f = await facts(s.id);
    expect(f.shipJobs[0]?.attempts).toBeGreaterThanOrEqual(2);
  });

  it('courier down for good: the booking ends in the dead-letter queue', async () => {
    const s = await sandbox({ courierDown: true });
    const id = await place(s.cookie, 'ship-dead-0001');
    await drainUntil(
      engine(() => 0),
      s.cookie,
      id,
      (x) => x.state === 'packed',
    );
    await drain(engine(() => 0));

    const [job] = (await facts(s.id)).shipJobs;
    expect(job).toMatchObject({ status: 'dead', attempts: 6 });
    expect(job?.last_error).toMatch(/^gave up after 6 attempts: Courier answered 503/);
  });

  it('lost parcel: shipment fails, the units go back on the shelf and the customer is refunded', async () => {
    const s = await sandbox({ courierFailDelivery: true });
    const id = await place(s.cookie, 'ship-lost-0001');
    const o = await drainUntil(engine(), s.cookie, id, (x) => x.state === 'refunded');

    expect(transitions(o).slice(-4)).toEqual([
      'shipped',
      'in_transit',
      'shipment_failed',
      'refunded',
    ]);
    const f = await facts(s.id);
    expect(f.clayPot).toEqual({ available: 6, reserved: 0 });
    expect(f.reservations).toEqual([{ status: 'returned' }]);
    expect(f.shipments).toEqual([{ status: 'failed', last_seq: 2 }]);
  });

  it('cancel after packing: packed units are returned and the payment refunded', async () => {
    const s = await sandbox({ courierDown: true });
    const id = await place(s.cookie, 'ship-cancel-packed-0001');
    const e = engine();
    const packed = await drainUntil(e, s.cookie, id, (x) => x.state === 'packed');

    const cancel = await app.inject({
      method: 'POST',
      url: `/v1/orders/${id}/cancel`,
      headers: { ...consoleJson, cookie: s.cookie, 'if-match': String(packed.version) },
      payload: {},
    });
    expect(cancel.statusCode).toBe(200);
    await setChaos(s.cookie, { courierDown: false });
    const o = await drainUntil(e, s.cookie, id, (x) => x.state === 'refunded');

    expect(transitions(o).slice(-3)).toEqual(['packed', 'cancelled', 'refunded']);
    const f = await facts(s.id);
    expect(f.clayPot).toEqual({ available: 6, reserved: 0 });
    expect(f.reservations).toEqual([{ status: 'returned' }]);
    expect(f.shipments).toEqual([]);
  });
});
