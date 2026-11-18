import { createDb } from '@sethu/db';
import { describe, expect, it } from 'vitest';
import { OutboxRelay } from '../../src/modules/outbox/index.ts';
import { Worker } from '../../src/modules/queue/index.ts';

// Nothing listens on port 9, so every query fails the way a dropped database
// connection would.
const unreachable = () =>
  createDb('postgres://sethu_app:x@127.0.0.1:9/sethu_test?connect_timeout=1', 1);

const until = async (condition: () => boolean, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

describe('background loops', () => {
  it('keep a worker alive and retrying while the database is unreachable', async () => {
    const db = unreachable();
    const errors: unknown[] = [];
    const worker = new Worker({
      db,
      id: 'resilient',
      handlers: new Map([['noop', () => Promise.resolve()]]),
      onLoopError: (error) => errors.push(error),
    });
    worker.start();
    await until(() => errors.length >= 2);
    await worker.stop();
    await db.destroy();
    expect(errors.length).toBeGreaterThanOrEqual(2);
  });

  it('keep the outbox relay alive and retrying while the database is unreachable', async () => {
    const db = unreachable();
    const errors: unknown[] = [];
    const relay = new OutboxRelay({
      db,
      subscriptions: new Map(),
      onLoopError: (error) => errors.push(error),
    });
    relay.start();
    await until(() => errors.length >= 2);
    await relay.stop();
    await db.destroy();
    expect(errors.length).toBeGreaterThanOrEqual(2);
  });
});
