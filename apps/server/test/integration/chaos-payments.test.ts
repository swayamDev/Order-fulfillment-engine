import type { OrderView } from '@sethu/contracts';
import { withSandbox, type Db } from '@sethu/db';
import { appDb, ownerDb } from '@sethu/db/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { createEngine, drain, type Engine } from '../../src/engine.ts';
import { httpPaymentsClient } from '../../src/modules/payments/index.ts';
import type { SimPaymentsConfig } from '../../src/modules/sim-payments/index.ts';
import { consoleJson, newSandbox, TEST_CONFIG } from './harness.ts';

const SECRET = 'test-sim-payments-secret-000000000000';
const API_KEY = 'sk_sim_test_000000000000';

let app: FastifyInstance;
let db: Db;
let owner: Db;
let baseUrl = '';

const sim: SimPaymentsConfig = {
  apiKey: API_KEY,
  signingSecret: SECRET,
  webhookUrl: () => `${baseUrl}/v1/webhooks/sim-payments`,
  delayMs: 0,
};
const payments = httpPaymentsClient({ baseUrl: () => `${baseUrl}/sim/payments`, apiKey: API_KEY });

beforeAll(async () => {
  db = appDb(16);
  owner = ownerDb();
  app = await buildApp({
    config: TEST_CONFIG,
    db,
    simPayments: sim,
    webhookSecrets: new Map([['sim-payments', [SECRET]]]),
  });
  baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
});

afterAll(async () => {
  await app.close();
  await db.destroy();
  await owner.destroy();
});

const engine = (random?: () => number): Engine =>
  createEngine(db, {
    simPayments: sim,
    payments,
    workerCount: 2,
    ...(random === undefined ? {} : { worker: { random } }),
  });

async function sandboxWithChaos(patch: Record<string, unknown>) {
  const { cookie, id } = await newSandbox(app);
  const response = await app.inject({
    method: 'PATCH',
    url: '/v1/chaos',
    headers: { ...consoleJson, cookie },
    payload: patch,
  });
  expect(response.statusCode).toBe(200);
  return { cookie, id };
}

async function placeAndGet(cookie: string, key: string) {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/orders',
    headers: { ...consoleJson, cookie, 'idempotency-key': key },
    payload: { items: [{ sku: 'MUG-STONE-01', quantity: 1 }] },
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

/** Drains repeatedly until the order satisfies `done`, for up to 5 seconds. */
async function drainUntil(
  e: Engine,
  cookie: string,
  orderId: string,
  done: (o: OrderView) => boolean,
): Promise<OrderView> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    await drain(e);
    const o = await getOrder(cookie, orderId);
    if (done(o)) return o;
    if (Date.now() > deadline)
      throw new Error(`Order never reached the expected point: ${o.state}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const webhookLog = (o: OrderView) =>
  o.events
    .filter((e) => e.kind === 'webhook')
    .map(
      (e) => `${String(e.data['type'])}#${String(e.data['sequence'])} ${String(e.data['outcome'])}`,
    );

describe('chaos: the simulated payment provider misbehaves on request', () => {
  it('reads and updates settings per sandbox, rejecting unknown switches', async () => {
    const { cookie } = await sandboxWithChaos({ paymentsDuplicate: true });
    const other = await newSandbox(app);
    const mine = await app.inject({ method: 'GET', url: '/v1/chaos', headers: { cookie } });
    const theirs = await app.inject({
      method: 'GET',
      url: '/v1/chaos',
      headers: { cookie: other.cookie },
    });
    expect(mine.json()).toMatchObject({ paymentsDuplicate: true, paymentsDecline: false });
    expect(theirs.json()).toMatchObject({ paymentsDuplicate: false });

    const bad = await app.inject({
      method: 'PATCH',
      url: '/v1/chaos',
      headers: { ...consoleJson, cookie },
      payload: { deleteEverything: true },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('duplicate webhooks: each is stored once, counted, and the order is paid once', async () => {
    const { cookie, id: sandbox } = await sandboxWithChaos({ paymentsDuplicate: true });
    const orderId = await placeAndGet(cookie, 'chaos-dupe-0001');
    await drain(engine());

    const o = await getOrder(cookie, orderId);
    expect(o).toMatchObject({ state: 'paid', version: 4 });
    // With two workers, captured may be processed before authorized commits;
    // it is then briefly held and released. Either way it applies once.
    expect(webhookLog(o).filter((w) => !w.endsWith('held'))).toEqual([
      'payment.authorized#1 noted',
      'payment.captured#2 apply',
    ]);
    const inbox = await withSandbox(owner, sandbox, (tx) =>
      tx.selectFrom('webhook_inbox').select(['event_type', 'duplicate_count']).execute(),
    );
    expect(inbox).toHaveLength(2);
    expect(inbox.every((i) => i.duplicate_count === 1)).toBe(true);
  });

  it('out of order: captured arrives first, is held, then applied after authorized', async () => {
    // A one second gap between deliveries, so "captured first" is what actually
    // happens, and there is a clear window in which captured waits, held.
    const { cookie } = await sandboxWithChaos({
      paymentsReverseOrder: true,
      paymentsExtraDelayMs: 1_000,
    });
    const orderId = await placeAndGet(cookie, 'chaos-reverse-0001');
    const e = engine();

    const log = await drainUntil(e, cookie, orderId, (o) => webhookLog(o).length > 0);
    expect(log.state).toBe('payment_pending');
    expect(webhookLog(log)).toEqual(['payment.captured#2 held']);

    const settled = await drainUntil(e, cookie, orderId, (o) => o.state === 'paid');
    expect(webhookLog(settled)).toEqual([
      'payment.captured#2 held',
      'payment.authorized#1 noted',
      'payment.captured#2 apply',
    ]);
  });

  it('delayed webhooks: the order waits in payment_pending, then settles', async () => {
    const { cookie } = await sandboxWithChaos({ paymentsExtraDelayMs: 1_000 });
    const orderId = await placeAndGet(cookie, 'chaos-delay-0001');
    const e = engine();
    await drain(e);
    const waiting = await getOrder(cookie, orderId);
    expect(waiting.state).toBe('payment_pending');
    expect(webhookLog(waiting)).toEqual([]);

    const settled = await drainUntil(e, cookie, orderId, (o) => o.state === 'paid');
    expect(webhookLog(settled)).toEqual(['payment.authorized#1 noted', 'payment.captured#2 apply']);
  });

  it('declined payment: the order moves to payment_failed', async () => {
    const { cookie } = await sandboxWithChaos({ paymentsDecline: true });
    const orderId = await placeAndGet(cookie, 'chaos-decline-0001');
    await drain(engine());

    const o = await getOrder(cookie, orderId);
    expect(webhookLog(o)).toEqual(['payment.failed#1 apply']);
    const transitions = o.events.filter((e) => e.kind === 'transition').map((e) => e.data['to']);
    expect(transitions).toContain('payment_failed');
  });

  it('lost first webhook: the next one is held, then dead-lettered with a clear reason', async () => {
    const { cookie, id: sandbox } = await sandboxWithChaos({ paymentsDropFirst: true });
    const orderId = await placeAndGet(cookie, 'chaos-drop-0001');
    await drain(engine(() => 0));

    const o = await getOrder(cookie, orderId);
    expect(o.state).toBe('payment_pending');
    expect(webhookLog(o)).toEqual(['payment.captured#2 held']);
    const dead = await withSandbox(owner, sandbox, (tx) =>
      tx.selectFrom('jobs').selectAll().where('status', '=', 'dead').execute(),
    );
    expect(dead).toHaveLength(1);
    expect(dead[0]?.queue).toBe('webhook.process');
    expect(dead[0]?.last_error).toContain('out_of_order_unresolved');
    expect(dead[0]?.last_error).toContain('needs sequence 1 first');
  });
});
