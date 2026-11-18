import type { OrderView } from '@sethu/contracts';
import { withSandbox, type Db } from '@sethu/db';
import { appDb, ownerDb } from '@sethu/db/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { createEngine, drain } from '../../src/engine.ts';
import { httpPaymentsClient, type PaymentsClient } from '../../src/modules/payments/index.ts';
import type { SimPaymentsConfig } from '../../src/modules/sim-payments/index.ts';
import { signatureHeader } from '../../src/modules/webhooks/index.ts';
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

async function placeOrder(cookie: string, key: string) {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/orders',
    headers: { ...consoleJson, cookie, 'idempotency-key': key },
    payload: { items: [{ sku: 'POT-CLAY-06', quantity: 1 }] },
  });
  return response.json<OrderView>();
}

async function getOrder(cookie: string, id: string) {
  const response = await app.inject({
    method: 'GET',
    url: `/v1/orders/${id}`,
    headers: { cookie },
  });
  return response.json<OrderView>();
}

async function sandboxRows(sandboxId: string) {
  return withSandbox(owner, sandboxId, async (tx) => ({
    intents: await tx.selectFrom('sim_payment_intents').selectAll().execute(),
    paymentJobs: await tx
      .selectFrom('jobs')
      .selectAll()
      .where('queue', '=', 'payments.request')
      .execute(),
    inbox: await tx.selectFrom('webhook_inbox').selectAll().execute(),
  }));
}

describe('payment flow, placed to paid', () => {
  it('reserves, charges through the simulated provider and settles on its webhooks', async () => {
    const { cookie, id: sandbox } = await newSandbox(app);
    const placed = await placeOrder(cookie, 'pay-happy-0001');
    await drain(createEngine(db, { simPayments: sim, payments, workerCount: 2 }));

    const order = await getOrder(cookie, placed.id);
    expect(order).toMatchObject({ state: 'paid', version: 4, paymentCaptured: true });

    const transitions = order.events
      .filter((e) => e.kind === 'transition')
      .map((e) => e.data['to']);
    expect(transitions).toEqual(['placed', 'inventory_reserved', 'payment_pending', 'paid']);

    // Per-payment sequencing makes the order of application deterministic,
    // even with two workers racing: authorized (1) always before captured (2).
    const webhooks = order.events
      .filter((e) => e.kind === 'webhook')
      .map((e) => `${String(e.data['type'])} ${String(e.data['outcome'])}`);
    expect(webhooks.filter((w) => !w.endsWith('held'))).toEqual([
      'payment.authorized noted',
      'payment.captured apply',
    ]);
    const webhookEvents = order.events.filter((e) => e.kind === 'webhook');
    expect(webhookEvents.every((w) => w.data['simulated'] === true)).toBe(true);

    const { intents, inbox } = await sandboxRows(sandbox);
    expect(intents).toHaveLength(1);
    expect(intents[0]?.amount_minor).toBe(245_000);
    expect(inbox.every((i) => i.processed_at !== null)).toBe(true);
  });

  it('reaches paid with the engine running on its own wakeups, no draining', async () => {
    const { cookie } = await newSandbox(app);
    const engine = createEngine(db, { simPayments: sim, payments, workerCount: 2 });
    engine.start();
    try {
      const placed = await placeOrder(cookie, 'pay-live-0001');
      // What the API does after committing an order.
      engine.notify();
      const deadline = Date.now() + 10_000;
      let state = placed.state;
      while (state !== 'paid' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        state = (await getOrder(cookie, placed.id)).state;
      }
      expect(state).toBe('paid');
    } finally {
      await engine.stop();
    }
  });

  it('charges once when a worker dies after calling the provider but before committing', async () => {
    const { cookie, id: sandbox } = await newSandbox(app);
    const placed = await placeOrder(cookie, 'pay-crash-0001');

    let calls = 0;
    const crashOnce: PaymentsClient = {
      async createIntent(input) {
        const intent = await payments.createIntent(input);
        calls++;
        if (calls === 1) throw new Error('worker crashed after the provider call');
        return intent;
      },
    };
    await drain(
      createEngine(db, {
        simPayments: sim,
        payments: crashOnce,
        workerCount: 1,
        worker: { random: () => 0 },
      }),
    );

    const order = await getOrder(cookie, placed.id);
    expect(order.state).toBe('paid');
    const { intents, paymentJobs } = await sandboxRows(sandbox);
    expect(calls).toBe(2);
    expect(intents).toHaveLength(1);
    expect(paymentJobs[0]).toMatchObject({ status: 'succeeded', attempts: 2 });
  });

  it('ignores a captured webhook delivered again after the order is paid', async () => {
    const { cookie, id: sandbox } = await newSandbox(app);
    const placed = await placeOrder(cookie, 'pay-dupe-0001');
    const engine = createEngine(db, { simPayments: sim, payments, workerCount: 1 });
    await drain(engine);

    const { inbox } = await sandboxRows(sandbox);
    const captured = inbox.find((i) => i.event_type === 'payment.captured');
    if (captured === undefined) throw new Error('no captured webhook');
    const body = JSON.stringify(captured.payload);
    const redelivered = await fetch(`${baseUrl}/v1/webhooks/sim-payments`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'sethu-signature': signatureHeader([SECRET], Math.floor(Date.now() / 1000), body),
      },
      body,
    });
    expect(await redelivered.json()).toEqual({ received: true, duplicate: true });
    await drain(engine);

    const order = await getOrder(cookie, placed.id);
    expect(order).toMatchObject({ state: 'paid', version: 4 });
    const capturedWebhooks = order.events.filter(
      (e) => e.kind === 'webhook' && e.data['type'] === 'payment.captured',
    );
    expect(capturedWebhooks).toHaveLength(1);
  });
});
