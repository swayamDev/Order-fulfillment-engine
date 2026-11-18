import { randomUUID } from 'node:crypto';
import type { OrderView } from '@sethu/contracts';
import { withSandbox, type Db } from '@sethu/db';
import { appDb, ownerDb } from '@sethu/db/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { createEngine, drain, type Engine } from '../../src/engine.ts';
import type { DeadLetterView } from '../../src/modules/dead-letters/index.ts';
import { httpPaymentsClient } from '../../src/modules/payments/index.ts';
import { httpCourierClient } from '../../src/modules/shipping/index.ts';
import type { SimCourierConfig } from '../../src/modules/sim-courier/index.ts';
import type { SimPaymentsConfig } from '../../src/modules/sim-payments/index.ts';
import { signatureHeader } from '../../src/modules/webhooks/index.ts';
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
const engine = (): Engine =>
  createEngine(db, {
    payments: httpPaymentsClient({ baseUrl: () => `${baseUrl}/sim/payments`, apiKey: PAY_KEY }),
    courier: httpCourierClient({ baseUrl: () => `${baseUrl}/sim/courier`, apiKey: SHIP_KEY }),
    simPayments,
    simCourier,
    workerCount: 2,
    // Zero jitter: retries are due at once, so failures exhaust their attempts now.
    worker: { random: () => 0 },
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

async function sandbox(chaos: Record<string, unknown>) {
  const s = await newSandbox(app);
  await setChaos(s.cookie, chaos);
  return s;
}

async function setChaos(cookie: string, chaos: Record<string, unknown>) {
  await app.inject({
    method: 'PATCH',
    url: '/v1/chaos',
    headers: { ...consoleJson, cookie },
    payload: chaos,
  });
}

async function place(cookie: string) {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/orders',
    headers: { ...consoleJson, cookie, 'idempotency-key': `dlq-${randomUUID()}` },
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

async function deadLetters(cookie: string) {
  const response = await app.inject({
    method: 'GET',
    url: '/v1/dead-letters',
    headers: { cookie },
  });
  return response.json<DeadLetterView[]>();
}

function replay(cookie: string, jobId: string, headers: Record<string, string> = consoleJson) {
  return app.inject({
    method: 'POST',
    url: `/v1/dead-letters/${jobId}/replay`,
    headers: { ...headers, cookie },
    payload: {},
  });
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

describe('dead-letter queue', () => {
  it('lists a dead booking, and replaying it after the courier recovers delivers the order', async () => {
    const s = await sandbox({ courierDown: true });
    const id = await place(s.cookie);
    const e = engine();
    await drainUntil(e, s.cookie, id, (o) => o.state === 'packed');
    await drain(e);

    const [dead] = await deadLetters(s.cookie);
    expect(dead).toMatchObject({ queue: 'fulfillment.ship', attempts: 6, orderId: id, replays: 0 });
    expect(dead?.reason).toMatch(/^gave up after 6 attempts: Courier answered 503/);

    await setChaos(s.cookie, { courierDown: false });
    const response = await replay(s.cookie, dead?.id ?? '');
    expect(response.statusCode).toBe(202);
    const o = await drainUntil(e, s.cookie, id, (x) => x.state === 'delivered');
    expect(o.state).toBe('delivered');

    expect(await deadLetters(s.cookie)).toEqual([]);
    const audit = await withSandbox(owner, s.id, (tx) =>
      tx.selectFrom('job_replays').selectAll().execute(),
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      job_id: dead?.id,
      queue: 'fulfillment.ship',
      previous_attempts: 6,
      requested_by: 'console',
    });
    expect(audit[0]?.previous_error).toContain('Courier answered 503');
  });

  it('replays a held payment event once its missing predecessor has arrived', async () => {
    const s = await sandbox({ paymentsDropFirst: true });
    const id = await place(s.cookie);
    const e = engine();
    await drainUntil(e, s.cookie, id, (o) => o.state === 'payment_pending');
    await drain(e);
    const [dead] = await deadLetters(s.cookie);
    expect(dead).toMatchObject({ queue: 'webhook.process', orderId: id });
    expect(dead?.reason).toContain('out_of_order_unresolved');

    // The lost payment.authorized (sequence 1) finally turns up.
    const intent = await withSandbox(owner, s.id, (tx) =>
      tx.selectFrom('payments').select('intent_id').executeTakeFirstOrThrow(),
    );
    const body = JSON.stringify({
      id: `evt_late_${randomUUID()}`,
      type: 'payment.authorized',
      created: Math.floor(Date.now() / 1000),
      sandbox_id: s.id,
      simulated: true,
      data: { intent_id: intent.intent_id, order_id: id, sequence: 1 },
    });
    await app.inject({
      method: 'POST',
      url: '/v1/webhooks/sim-payments',
      headers: {
        'content-type': 'application/json',
        'sethu-signature': signatureHeader([PAY_SECRET], Math.floor(Date.now() / 1000), body),
      },
      payload: body,
    });
    await drain(e);
    expect((await getOrder(s.cookie, id)).state).toBe('payment_pending');

    // Now the operator replays the dead captured event, and it applies.
    expect((await replay(s.cookie, dead?.id ?? '')).statusCode).toBe(202);
    const o = await drainUntil(e, s.cookie, id, (x) => x.state === 'delivered');
    const payments = o.events
      .filter((ev) => ev.kind === 'webhook' && String(ev.data['type']).startsWith('payment.'))
      .map(
        (ev) =>
          `${String(ev.data['type'])}#${String(ev.data['sequence'])} ${String(ev.data['outcome'])}`,
      );
    expect(payments).toEqual([
      'payment.captured#2 held',
      'payment.authorized#1 noted',
      'payment.captured#2 apply',
    ]);
  });

  it('only replays dead jobs, only in your own sandbox, only from the console', async () => {
    const s = await sandbox({ courierDown: true });
    const other = await newSandbox(app);
    const id = await place(s.cookie);
    const e = engine();
    await drainUntil(e, s.cookie, id, (o) => o.state === 'packed');
    await drain(e);
    const [dead] = await deadLetters(s.cookie);
    const jobId = dead?.id ?? '';

    expect((await replay(other.cookie, jobId)).statusCode).toBe(404);
    expect((await replay(s.cookie, randomUUID())).statusCode).toBe(404);
    expect((await replay(s.cookie, jobId, { 'content-type': 'application/json' })).statusCode).toBe(
      403,
    );
    expect((await replay(s.cookie, jobId)).statusCode).toBe(202);
    const again = await replay(s.cookie, jobId);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ type: 'not_dead' });
  });
});
