import { randomUUID } from 'node:crypto';
import { withSandbox, type Db } from '@sethu/db';
import { appDb, createTestSandbox, ownerDb } from '@sethu/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  markProcessed,
  OutboxRelay,
  publish,
  type OutboxMessage,
} from '../../src/modules/outbox/index.ts';
import { Worker } from '../../src/modules/queue/index.ts';

let db: Db;
let owner: Db;

beforeAll(() => {
  db = appDb(12);
  owner = ownerDb();
});

afterAll(async () => {
  await db.destroy();
  await owner.destroy();
});

const subscriptions = new Map([
  ['order.placed', ['reserve-inventory', 'notify-console']],
  ['order.silent', []],
]);

function event(sandboxId: string, topic = 'order.placed') {
  return { sandboxId, topic, aggregateId: randomUUID(), payload: { note: 'test' } };
}

async function rows(sandboxId: string) {
  return withSandbox(owner, sandboxId, async (tx) => ({
    outbox: await tx.selectFrom('outbox').selectAll().execute(),
    jobs: await tx.selectFrom('jobs').selectAll().orderBy('queue').execute(),
  }));
}

describe('transactional outbox', () => {
  it('writes no event when the state change rolls back', async () => {
    const sandbox = await createTestSandbox(owner);
    await expect(
      withSandbox(db, sandbox, async (tx) => {
        await publish(tx, event(sandbox));
        throw new Error('payment provider rejected the order');
      }),
    ).rejects.toThrow('payment provider rejected the order');
    expect((await rows(sandbox)).outbox).toEqual([]);
  });

  it('fans an event out to one job per subscriber and marks it published', async () => {
    const sandbox = await createTestSandbox(owner);
    const e = event(sandbox);
    const id = await withSandbox(db, sandbox, (tx) => publish(tx, e));
    const relay = new OutboxRelay({ db, subscriptions });
    while ((await relay.runOnce()) > 0) {
      /* drain */
    }

    const { outbox, jobs } = await rows(sandbox);
    expect(outbox[0]?.published_at).not.toBeNull();
    expect(jobs.map((j) => [j.queue, j.dedupe_key])).toEqual([
      ['notify-console', `${id}:notify-console`],
      ['reserve-inventory', `${id}:reserve-inventory`],
    ]);
    expect(jobs[0]?.payload).toEqual({
      messageId: id,
      topic: 'order.placed',
      aggregateId: e.aggregateId,
      payload: { note: 'test' },
    });
  });

  it('publishes events nobody subscribes to without creating jobs', async () => {
    const sandbox = await createTestSandbox(owner);
    await withSandbox(db, sandbox, (tx) => publish(tx, event(sandbox, 'order.silent')));
    await new OutboxRelay({ db, subscriptions }).runOnce();
    const { outbox, jobs } = await rows(sandbox);
    expect(outbox[0]?.published_at).not.toBeNull();
    expect(jobs).toEqual([]);
  });

  it('creates each job once with four relays racing over 200 events', async () => {
    const sandboxes = await Promise.all([1, 2].map(() => createTestSandbox(owner)));
    for (const sandbox of sandboxes) {
      await withSandbox(db, sandbox, async (tx) => {
        for (let i = 0; i < 100; i++) await publish(tx, event(sandbox));
      });
    }
    const relays = Array.from(
      { length: 4 },
      () => new OutboxRelay({ db, subscriptions, batchSize: 7 }),
    );
    await Promise.all(
      relays.map(async (relay) => {
        while ((await relay.runOnce()) > 0) {
          /* drain */
        }
      }),
    );
    for (const sandbox of sandboxes) {
      const { outbox, jobs } = await rows(sandbox);
      expect(outbox.every((o) => o.published_at !== null)).toBe(true);
      expect(jobs).toHaveLength(200);
      expect(new Set(jobs.map((j) => j.dedupe_key)).size).toBe(200);
    }
  });

  it('does not duplicate jobs when an event is relayed again', async () => {
    const sandbox = await createTestSandbox(owner);
    await withSandbox(db, sandbox, (tx) => publish(tx, event(sandbox)));
    const relay = new OutboxRelay({ db, subscriptions });
    await relay.runOnce();
    // Simulate a relay that crashed after creating jobs but before its commit
    // was acknowledged, so the event looks unpublished and is relayed again.
    await withSandbox(owner, sandbox, (tx) =>
      tx.updateTable('outbox').set({ published_at: null }).execute(),
    );
    await relay.runOnce();
    expect((await rows(sandbox)).jobs).toHaveLength(2);
  });

  it('keeps each event inside its own sandbox', async () => {
    const a = await createTestSandbox(owner);
    const b = await createTestSandbox(owner);
    await withSandbox(db, a, (tx) => publish(tx, event(a)));
    await withSandbox(db, b, (tx) => publish(tx, event(b)));
    await new OutboxRelay({ db, subscriptions }).runOnce();
    for (const sandbox of [a, b]) {
      const { jobs } = await rows(sandbox);
      expect(jobs).toHaveLength(2);
      expect(jobs.every((j) => j.sandbox_id === sandbox)).toBe(true);
    }
  });
});

describe('idempotent consumers', () => {
  it('apply a redelivered message only once', async () => {
    const sandbox = await createTestSandbox(owner);
    await withSandbox(db, sandbox, (tx) => publish(tx, event(sandbox)));
    await new OutboxRelay({ db, subscriptions: new Map([['order.placed', ['count']]]) }).runOnce();

    let effects = 0;
    const worker = new Worker({
      db,
      id: 'counter',
      handlers: new Map([
        [
          'count',
          async (tx, job) => {
            const message = job.payload as unknown as OutboxMessage;
            if (!(await markProcessed(tx, 'count', message.messageId, job.sandbox_id))) return;
            effects++;
          },
        ],
      ]),
    });
    expect(await worker.runOnce()).toBe(1);

    // Redeliver: the same message arrives again as a fresh job.
    await withSandbox(owner, sandbox, (tx) =>
      tx
        .updateTable('jobs')
        .set({ status: 'queued', finished_at: null })
        .where('queue', '=', 'count')
        .execute(),
    );
    expect(await worker.runOnce()).toBe(1);
    expect(effects).toBe(1);
  });
});
