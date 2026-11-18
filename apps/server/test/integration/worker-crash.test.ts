// Crash a real worker process mid-step and watch the system recover.
//
// The API, simulated providers and outbox relay run in this test process; the
// workers run as real child processes under the Supervisor, as in production.

import type { OrderView } from '@sethu/contracts';
import { withSandbox, type Db } from '@sethu/db';
import { appDb, ownerDb, TEST_APP_URL } from '@sethu/db/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { createEngine, type Engine } from '../../src/engine.ts';
import { Supervisor, type WorkerExit } from '../../src/supervisor.ts';
import type { SimCourierConfig } from '../../src/modules/sim-courier/index.ts';
import type { SimPaymentsConfig } from '../../src/modules/sim-payments/index.ts';
import { consoleJson, newSandbox, TEST_CONFIG, TEST_SESSION_KEY } from './harness.ts';

const PAY_SECRET = 'test-sim-payments-secret-000000000000';
const SHIP_SECRET = 'test-sim-courier-secret-0000000000000';
const PAY_KEY = 'sk_sim_test_000000000000';
const SHIP_KEY = 'ck_sim_test_000000000000';
const LEASE_SECONDS = 2;

let app: FastifyInstance;
let db: Db;
let owner: Db;
let engine: Engine;
let supervisor: Supervisor;
const exits: WorkerExit[] = [];

beforeAll(async () => {
  db = appDb(12);
  owner = ownerDb();
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

  // Relay only: every job runs in the worker processes.
  engine = createEngine(db, {
    workerCount: 0,
    onWake: () => {
      supervisor.broadcast({ type: 'wake' });
    },
  });
  app = await buildApp({
    config: TEST_CONFIG,
    db,
    simPayments,
    simCourier,
    webhookSecrets: new Map([
      ['sim-payments', [PAY_SECRET]],
      ['sim-courier', [SHIP_SECRET]],
    ]),
    onEventsCommitted: () => {
      engine.notify();
    },
  });
  baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });

  supervisor = new Supervisor({
    processes: 1,
    env: {
      ...process.env,
      DATABASE_URL: TEST_APP_URL,
      PUBLIC_API_URL: baseUrl,
      SESSION_SIGNING_KEYS: TEST_SESSION_KEY,
      SIM_PAYMENTS_WEBHOOK_SECRETS: PAY_SECRET,
      SIM_PAYMENTS_API_KEY: PAY_KEY,
      SIM_PAYMENTS_DELAY_MS: '0',
      SIM_COURIER_WEBHOOK_SECRETS: SHIP_SECRET,
      SIM_COURIER_API_KEY: SHIP_KEY,
      SIM_COURIER_DELAY_MS: '0',
      WORKER_CONCURRENCY: '1',
      WORKER_LEASE_SECONDS: String(LEASE_SECONDS),
    },
  });
  supervisor.on('message', (message: { type?: string }) => {
    if (message.type === 'committed') engine.notify();
  });
  supervisor.on('exit', (exit: WorkerExit) => exits.push(exit));
  const ready = new Promise<void>((resolve) => {
    supervisor.once('message', () => {
      resolve();
    });
  });
  supervisor.start();
  engine.start();
  await ready;
}, 30_000);

afterAll(async () => {
  await supervisor.stop();
  await engine.stop();
  await app.close();
  await db.destroy();
  await owner.destroy();
});

async function getOrder(cookie: string, id: string) {
  const response = await app.inject({
    method: 'GET',
    url: `/v1/orders/${id}`,
    headers: { cookie },
  });
  return response.json<OrderView>();
}

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean, ms = 20_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out; last value ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe('chaos: crash a worker mid-step', () => {
  it('kills the worker before its step commits, then a restarted worker finishes the order', async () => {
    const { cookie, id: sandbox } = await newSandbox(app);
    await app.inject({
      method: 'PATCH',
      url: '/v1/chaos',
      headers: { ...consoleJson, cookie },
      payload: { crashNextStep: true },
    });
    const pidBefore = supervisor.pids()[0];

    const placed = await app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: { ...consoleJson, cookie, 'idempotency-key': 'crash-mid-step-0001' },
      payload: { items: [{ sku: 'TEA-NILGIRI-100', quantity: 3 }] },
    });
    const orderId = placed.json<OrderView>().id;
    engine.notify();

    // The worker process dies with the crash exit code...
    const crash = await waitFor(
      () => Promise.resolve(exits.find((e) => e.pid === pidBefore)),
      (e) => e !== undefined,
    );
    expect(crash?.code).toBe(137);

    // ...the supervisor starts a new one, which reclaims the job once the
    // lease runs out and takes the order all the way to delivered.
    const order = await waitFor(
      () => getOrder(cookie, orderId),
      (o) => o.state === 'delivered',
    );
    expect(supervisor.pids()[0]).not.toBe(pidBefore);

    // The crashed step (reserving stock) left no trace: its transaction never
    // committed, so stock was reserved exactly once, by the retry.
    const transitions = order.events
      .filter((e) => e.kind === 'transition')
      .map((e) => e.data['to']);
    expect(transitions).toEqual([
      'placed',
      'inventory_reserved',
      'payment_pending',
      'paid',
      'packed',
      'shipped',
      'in_transit',
      'delivered',
    ]);
    const facts = await withSandbox(owner, sandbox, async (tx) => ({
      stock: await tx
        .selectFrom('stock')
        .select(['available', 'reserved'])
        .where('sku', '=', 'TEA-NILGIRI-100')
        .executeTakeFirstOrThrow(),
      reserveJob: await tx
        .selectFrom('jobs')
        .select(['status', 'attempts'])
        .where('queue', '=', 'inventory.reserve')
        .executeTakeFirstOrThrow(),
      chaos: await tx.selectFrom('chaos_settings').select('crash_next_step').executeTakeFirst(),
    }));
    expect(facts.stock).toEqual({ available: 22, reserved: 0 });
    expect(facts.reserveJob).toEqual({ status: 'succeeded', attempts: 2 });
    // The switch fires once: it was turned off when the crash was armed.
    expect(facts.chaos?.crash_next_step).toBe(false);
  }, 40_000);
});
