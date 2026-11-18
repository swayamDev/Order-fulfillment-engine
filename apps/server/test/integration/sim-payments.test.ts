import { randomUUID } from 'node:crypto';
import { withSandbox, type Db } from '@sethu/db';
import { appDb, ownerDb } from '@sethu/db/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { createEngine, drain } from '../../src/engine.ts';
import type { IntentResponse, SimPaymentsConfig } from '../../src/modules/sim-payments/index.ts';
import { newSandbox, TEST_CONFIG } from './harness.ts';

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

beforeAll(async () => {
  db = appDb();
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

function createIntent(sandboxId: string, key: string, orderId = randomUUID(), apiKey = API_KEY) {
  return fetch(`${baseUrl}/sim/payments/v1/intents`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'idempotency-key': key,
    },
    body: JSON.stringify({
      sandbox_id: sandboxId,
      order_id: orderId,
      amount_minor: 131_000,
      currency: 'INR',
    }),
  });
}

async function simState(sandboxId: string) {
  return withSandbox(owner, sandboxId, async (tx) => ({
    intents: await tx.selectFrom('sim_payment_intents').selectAll().execute(),
    deliveries: await tx
      .selectFrom('jobs')
      .selectAll()
      .where('queue', '=', 'sim-payments.deliver')
      .orderBy('run_at')
      .execute(),
    inbox: await tx.selectFrom('webhook_inbox').selectAll().orderBy('received_at').execute(),
  }));
}

describe('simulated payment provider', () => {
  it('creates a payment intent once per idempotency key and labels it simulated', async () => {
    const { id: sandbox } = await newSandbox(app);
    const orderId = randomUUID();
    const first = await createIntent(sandbox, 'order:abc:charge', orderId);
    const second = await createIntent(sandbox, 'order:abc:charge', orderId);

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(first.headers.get('x-sethu-simulated')).toBe('true');
    const a = (await first.json()) as IntentResponse;
    const b = (await second.json()) as IntentResponse;
    expect(b.id).toBe(a.id);
    expect(a).toMatchObject({ status: 'processing', simulated: true, order_id: orderId });

    const { intents, deliveries } = await simState(sandbox);
    expect(intents).toHaveLength(1);
    // Two webhooks scheduled (authorized, captured), not four.
    expect(deliveries).toHaveLength(2);
  });

  it('requires its API key', async () => {
    const { id: sandbox } = await newSandbox(app);
    const response = await createIntent(
      sandbox,
      'order:key:charge',
      randomUUID(),
      'sk_wrong_000000000000',
    );
    expect(response.status).toBe(401);
  });

  it('delivers signed webhooks over HTTP, in order, into the inbox', async () => {
    const { id: sandbox } = await newSandbox(app);
    await createIntent(sandbox, 'order:deliver:charge');
    // Deliveries only: nothing processes the inbox yet.
    await drain(createEngine(db, { simPayments: sim, workerCount: 1 }));

    const { deliveries, inbox } = await simState(sandbox);
    expect(deliveries.map((d) => d.status)).toEqual(['succeeded', 'succeeded']);
    expect(inbox.map((i) => i.event_type)).toEqual(['payment.authorized', 'payment.captured']);
    expect(inbox.every((i) => i.payload['simulated'] === true)).toBe(true);
  });

  it('retries with backoff while the webhook endpoint is unreachable', async () => {
    const { id: sandbox } = await newSandbox(app);
    await createIntent(sandbox, 'order:down:charge');
    const unreachable: SimPaymentsConfig = {
      ...sim,
      webhookUrl: () => 'http://127.0.0.1:9/v1/webhooks/sim-payments',
    };
    const engine = createEngine(db, { simPayments: unreachable, workerCount: 1 });
    await engine.workers[0]?.runOnce();

    const { deliveries, inbox } = await simState(sandbox);
    expect(inbox).toEqual([]);
    for (const delivery of deliveries) {
      expect(delivery.status).toBe('queued');
      expect(delivery.attempts).toBe(1);
      expect(delivery.last_error).toBeTruthy();
      expect(delivery.run_at.getTime()).toBeGreaterThanOrEqual(delivery.updated_at.getTime());
    }
  });
});
