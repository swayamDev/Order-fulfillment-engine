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
const engine = (): Engine => createEngine(db, { simPayments: sim, payments, workerCount: 2 });

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

async function sandbox(chaos: Record<string, unknown> = {}) {
  const s = await newSandbox(app);
  if (Object.keys(chaos).length > 0) {
    await app.inject({
      method: 'PATCH',
      url: '/v1/chaos',
      headers: { ...consoleJson, cookie: s.cookie },
      payload: chaos,
    });
  }
  return s;
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

function cancel(cookie: string, id: string, ifMatch?: string) {
  return app.inject({
    method: 'POST',
    url: `/v1/orders/${id}/cancel`,
    headers: { ...consoleJson, cookie, ...(ifMatch === undefined ? {} : { 'if-match': ifMatch }) },
    payload: {},
  });
}

async function drainUntil(e: Engine, cookie: string, id: string, done: (o: OrderView) => boolean) {
  const deadline = Date.now() + 6_000;
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

async function stock(sandboxId: string) {
  return withSandbox(owner, sandboxId, async (tx) => ({
    clayPot: await tx
      .selectFrom('stock')
      .select(['available', 'reserved'])
      .where('sku', '=', 'POT-CLAY-06')
      .executeTakeFirstOrThrow(),
    reservations: await tx.selectFrom('reservations').select('status').execute(),
    payments: await tx.selectFrom('payments').select(['status', 'last_seq']).execute(),
    simIntents: await tx.selectFrom('sim_payment_intents').select('status').execute(),
  }));
}

describe('compensations', () => {
  it('payment failed: releases the stock and cancels the order, with nothing to refund', async () => {
    const s = await sandbox({ paymentsDecline: true });
    const id = await place(s.cookie, 'comp-decline-0001');
    const o = await drainUntil(engine(), s.cookie, id, (x) => x.state === 'cancelled');

    expect(transitions(o)).toEqual([
      'placed',
      'inventory_reserved',
      'payment_pending',
      'payment_failed',
      'cancelled',
    ]);
    const after = await stock(s.id);
    expect(after.clayPot).toEqual({ available: 6, reserved: 0 });
    expect(after.reservations).toEqual([{ status: 'released' }]);
    expect(o.events.some((e) => e.data['action'] === 'refund_requested')).toBe(false);
  });

  it('cancel after payment: releases stock, refunds, and ends refunded', async () => {
    const s = await sandbox();
    const id = await place(s.cookie, 'comp-cancel-paid-0001');
    const e = engine();
    const paid = await drainUntil(e, s.cookie, id, (x) => x.state === 'paid');

    const response = await cancel(s.cookie, id, `"${String(paid.version)}"`);
    expect(response.statusCode).toBe(200);
    const o = await drainUntil(e, s.cookie, id, (x) => x.state === 'refunded');

    expect(transitions(o).slice(-3)).toEqual(['paid', 'cancelled', 'refunded']);
    const refund = o.events.find((ev) => ev.data['type'] === 'payment.refunded');
    expect(refund?.data).toMatchObject({ sequence: 3, outcome: 'apply' });
    const after = await stock(s.id);
    expect(after.clayPot).toEqual({ available: 6, reserved: 0 });
    expect(after.payments).toEqual([{ status: 'refunded', last_seq: 3 }]);
    expect(after.simIntents).toEqual([{ status: 'refunded' }]);
  });

  it('cancel while payment is pending: a capture that lands afterwards is refunded', async () => {
    const s = await sandbox({ paymentsExtraDelayMs: 1_000 });
    const id = await place(s.cookie, 'comp-cancel-pending-0001');
    const e = engine();
    const pending = await drainUntil(e, s.cookie, id, (x) => x.state === 'payment_pending');

    expect((await cancel(s.cookie, id, String(pending.version))).statusCode).toBe(200);
    const o = await drainUntil(e, s.cookie, id, (x) => x.state === 'refunded');

    const captured = o.events.find((ev) => ev.data['type'] === 'payment.captured');
    expect(captured?.data['outcome']).toBe('refund');
    expect(transitions(o).slice(-2)).toEqual(['cancelled', 'refunded']);
    expect((await stock(s.id)).clayPot).toEqual({ available: 6, reserved: 0 });
  });

  it('refunds once even if the refund job runs again', async () => {
    const s = await sandbox();
    const id = await place(s.cookie, 'comp-refund-once-0001');
    const e = engine();
    const paid = await drainUntil(e, s.cookie, id, (x) => x.state === 'paid');
    await cancel(s.cookie, id, String(paid.version));
    await drainUntil(e, s.cookie, id, (x) => x.state === 'refunded');

    await withSandbox(owner, s.id, (tx) =>
      tx
        .updateTable('jobs')
        .set({ status: 'queued', finished_at: null })
        .where('queue', '=', 'payments.refund')
        .execute(),
    );
    await drain(e);

    const deliveries = await withSandbox(owner, s.id, (tx) =>
      tx.selectFrom('jobs').select('payload').where('queue', '=', 'sim-payments.deliver').execute(),
    );
    const refundWebhooks = deliveries.filter(
      (d) => (d.payload['envelope'] as { type: string }).type === 'payment.refunded',
    );
    expect(refundWebhooks).toHaveLength(1);
    expect((await getOrder(s.cookie, id)).state).toBe('refunded');
  });
});

describe('cancel endpoint', () => {
  it('requires If-Match, rejects a stale version and a disallowed transition', async () => {
    const s = await sandbox();
    const id = await place(s.cookie, 'cancel-rules-0001');
    const e = engine();
    const paid = await drainUntil(e, s.cookie, id, (x) => x.state === 'paid');

    expect((await cancel(s.cookie, id)).statusCode).toBe(428);

    const stale = await cancel(s.cookie, id, '1');
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ type: 'stale_version', currentVersion: paid.version });

    const ok = await cancel(s.cookie, id, String(paid.version));
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['etag']).toBe(`"${String(paid.version + 1)}"`);
    // The same request again is now stale: the first one changed the order.
    expect((await cancel(s.cookie, id, String(paid.version))).statusCode).toBe(409);

    await drainUntil(e, s.cookie, id, (x) => x.state === 'refunded');
    const refunded = await getOrder(s.cookie, id);
    const notAllowed = await cancel(s.cookie, id, String(refunded.version));
    expect(notAllowed.statusCode).toBe(409);
    expect(notAllowed.json()).toMatchObject({ type: 'invalid_transition', state: 'refunded' });
  });

  it("cannot cancel another sandbox's order", async () => {
    const a = await sandbox();
    const b = await sandbox();
    const id = await place(a.cookie, 'cancel-other-0001');
    expect((await cancel(b.cookie, id, '1')).statusCode).toBe(404);
  });
});
