import { randomUUID } from 'node:crypto';
import type { OrderView } from '@sethu/contracts';
import { withSandbox, type Db } from '@sethu/db';
import { appDb, ownerDb } from '@sethu/db/testing';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { createEngine, drain, type Engine } from '../../src/engine.ts';
import type { PaymentsClient } from '../../src/modules/payments/index.ts';
import { signatureHeader } from '../../src/modules/webhooks/index.ts';
import { consoleJson, newSandbox, TEST_CONFIG } from './harness.ts';

const SECRET = 'test-sim-payments-secret-000000000000';

let app: FastifyInstance;
let db: Db;
let owner: Db;

/** Gives every order a predictable intent and sends no webhooks: the tests do. */
const stubPayments: PaymentsClient = {
  createIntent: (input) => Promise.resolve({ id: `pi_test_${input.orderId}` }),
  refund: () => Promise.resolve(),
};

beforeAll(async () => {
  db = appDb(12);
  owner = ownerDb();
  app = await buildApp({
    config: TEST_CONFIG,
    db,
    webhookSecrets: new Map([['sim-payments', [SECRET]]]),
  });
});

afterAll(async () => {
  await app.close();
  await db.destroy();
  await owner.destroy();
});

/** Jitter near the top of the window, so a held event would wait about 1 s. */
const engine = (random = () => 0.999): Engine =>
  createEngine(db, { payments: stubPayments, workerCount: 1, worker: { random } });

/** An order that has reached payment_pending, waiting for its webhooks. */
async function pendingOrder(e: Engine) {
  const { cookie, id: sandbox } = await newSandbox(app);
  const response = await app.inject({
    method: 'POST',
    url: '/v1/orders',
    headers: { ...consoleJson, cookie, 'idempotency-key': `ordering-${randomUUID()}` },
    payload: { items: [{ sku: 'STRAINER-STEEL', quantity: 1 }] },
  });
  const order = response.json<OrderView>();
  await drain(e);
  return { cookie, sandbox, orderId: order.id, intentId: `pi_test_${order.id}` };
}

type Pending = Awaited<ReturnType<typeof pendingOrder>>;

async function send(p: Pending, type: string, sequence: number, eventId = `evt_${randomUUID()}`) {
  const body = JSON.stringify({
    id: eventId,
    type,
    created: Math.floor(Date.now() / 1000),
    sandbox_id: p.sandbox,
    simulated: true,
    data: { intent_id: p.intentId, order_id: p.orderId, sequence },
  });
  const response = await app.inject({
    method: 'POST',
    url: '/v1/webhooks/sim-payments',
    headers: {
      'content-type': 'application/json',
      'sethu-signature': signatureHeader([SECRET], Math.floor(Date.now() / 1000), body),
    },
    payload: body,
  });
  expect(response.statusCode).toBe(200);
}

async function order(p: Pending) {
  const response = await app.inject({
    method: 'GET',
    url: `/v1/orders/${p.orderId}`,
    headers: { cookie: p.cookie },
  });
  return response.json<OrderView>();
}

const webhookLog = (o: OrderView) =>
  o.events
    .filter((e) => e.kind === 'webhook')
    .map(
      (e) => `${String(e.data['type'])}#${String(e.data['sequence'])} ${String(e.data['outcome'])}`,
    );

async function webhookJobs(p: Pending) {
  return withSandbox(owner, p.sandbox, (tx) =>
    tx
      .selectFrom('jobs')
      .selectAll()
      .where('queue', '=', 'webhook.process')
      .orderBy('created_at')
      .execute(),
  );
}

describe('payment webhooks are applied in per-payment sequence', () => {
  it('applies events that arrive in order', async () => {
    const e = engine();
    const p = await pendingOrder(e);
    await send(p, 'payment.authorized', 1);
    await send(p, 'payment.captured', 2);
    await drain(e);

    const o = await order(p);
    expect(o.state).toBe('paid');
    expect(webhookLog(o)).toEqual(['payment.authorized#1 noted', 'payment.captured#2 apply']);
  });

  it('holds an event that arrives early and applies it as soon as the gap fills', async () => {
    const e = engine();
    const p = await pendingOrder(e);

    await send(p, 'payment.captured', 2);
    await drain(e);
    let o = await order(p);
    expect(o.state).toBe('payment_pending');
    expect(webhookLog(o)).toEqual(['payment.captured#2 held']);
    const [held] = await webhookJobs(p);
    expect(held?.status).toBe('queued');
    expect(held?.last_error).toMatch(/^out_of_order_unresolved: payment.captured is sequence 2/);

    // The missing event arrives. Applying it releases the held one at once,
    // without waiting out its backoff.
    await send(p, 'payment.authorized', 1);
    await drain(e);
    o = await order(p);
    expect(o.state).toBe('paid');
    expect(webhookLog(o)).toEqual([
      'payment.captured#2 held',
      'payment.authorized#1 noted',
      'payment.captured#2 apply',
    ]);
    const transitions = o.events
      .filter((ev) => ev.kind === 'transition')
      .map((ev) => ev.data['to']);
    expect(transitions.at(-1)).toBe('paid');
  });

  it('ignores an event whose sequence was already applied, even with a new event id', async () => {
    const e = engine();
    const p = await pendingOrder(e);
    await send(p, 'payment.authorized', 1);
    await send(p, 'payment.captured', 2);
    await drain(e);
    // A provider bug: the same step sent again under a different event id.
    await send(p, 'payment.captured', 2);
    await drain(e);

    const o = await order(p);
    expect(o).toMatchObject({ state: 'paid', version: 4 });
    expect(webhookLog(o).at(-1)).toBe('payment.captured#2 ignored');
  });

  it('dead-letters a held event when its predecessor never arrives', async () => {
    // Zero jitter: each retry is due at once, so all 8 attempts run now.
    const e = engine(() => 0);
    const p = await pendingOrder(e);
    await send(p, 'payment.captured', 2);
    await drain(e);

    const [job] = await webhookJobs(p);
    expect(job).toMatchObject({ status: 'dead', attempts: 8 });
    expect(job?.last_error).toBe(
      'gave up after 8 attempts: out_of_order_unresolved: payment.captured is sequence 2 ' +
        'and needs sequence 1 first (payment has applied up to 0)',
    );
    const o = await order(p);
    expect(o.state).toBe('payment_pending');
    // Noted once on the timeline, not once per attempt.
    expect(webhookLog(o)).toEqual(['payment.captured#2 held']);
  });

  it('dead-letters a held event once it has waited longer than 10 minutes', async () => {
    const e = engine();
    const p = await pendingOrder(e);
    await send(p, 'payment.captured', 2);
    await drain(e);
    // Pretend the event arrived 11 minutes ago, then let its retry run.
    await withSandbox(owner, p.sandbox, async (tx) => {
      await tx
        .updateTable('webhook_inbox')
        .set({
          received_at: sql<Date>`now() - interval '11 minutes'`,
          held_at: sql<Date>`now() - interval '11 minutes'`,
        })
        .execute();
      await tx
        .updateTable('jobs')
        .set({ run_at: sql<Date>`now()` })
        .where('queue', '=', 'webhook.process')
        .execute();
    });
    await drain(e);

    const [job] = await webhookJobs(p);
    expect(job?.status).toBe('dead');
    expect(job?.attempts).toBe(2);
    expect(job?.last_error).toMatch(
      /^out_of_order_unresolved: payment.captured is sequence 2 .*; held 11 min, longer than the 10 min limit$/,
    );
    const o = await order(p);
    expect(webhookLog(o)).toEqual(['payment.captured#2 held', 'payment.captured#2 dead_lettered']);
  });

  it('keeps sequences separate per payment', async () => {
    const e = engine();
    const a = await pendingOrder(e);
    const b = await pendingOrder(e);
    // b's captured is early for b, even though a has already reached sequence 1.
    await send(a, 'payment.authorized', 1);
    await send(b, 'payment.captured', 2);
    await drain(e);
    expect(webhookLog(await order(a))).toEqual(['payment.authorized#1 noted']);
    expect(webhookLog(await order(b))).toEqual(['payment.captured#2 held']);
  });
});
