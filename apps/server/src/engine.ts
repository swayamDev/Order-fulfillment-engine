// Wires the modules together: which consumer reacts to which event, and which
// handler runs each queue. The only place that knows the whole flow.

import type { Db } from '@sethu/db';
import { RESERVE_INVENTORY, reserveInventory } from './modules/inventory/index.ts';
import { OutboxRelay, type Subscriptions } from './modules/outbox/index.ts';
import { Worker, type JobHandler } from './modules/queue/index.ts';

export const SUBSCRIPTIONS: Subscriptions = new Map([['order.placed', [RESERVE_INVENTORY]]]);

export const HANDLERS: ReadonlyMap<string, JobHandler> = new Map([
  [RESERVE_INVENTORY, reserveInventory],
]);

export interface Engine {
  readonly relay: OutboxRelay;
  readonly workers: readonly Worker[];
  start(): void;
  stop(): Promise<void>;
  /** Wakes the relay after new events commit; the relay then wakes the workers. */
  notify(): void;
}

export function createEngine(db: Db, workerCount = 2): Engine {
  const workers = Array.from(
    { length: workerCount },
    (_, i) => new Worker({ db, id: `worker-${process.pid}-${i}`, handlers: HANDLERS }),
  );
  const relay = new OutboxRelay({
    db,
    subscriptions: SUBSCRIPTIONS,
    onPublished: () => {
      for (const worker of workers) worker.waker.notify();
    },
  });
  return {
    relay,
    workers,
    start() {
      relay.start();
      for (const worker of workers) worker.start();
    },
    async stop() {
      await relay.stop();
      await Promise.all(workers.map((w) => w.stop()));
    },
    notify() {
      relay.waker.notify();
    },
  };
}

/** Runs relay and workers until nothing is left to do. For tests and scripts. */
export async function drain(engine: Pick<Engine, 'relay' | 'workers'>): Promise<void> {
  for (;;) {
    let progress = await engine.relay.runOnce();
    const claimed = await Promise.all(engine.workers.map((w) => w.runOnce()));
    progress += claimed.reduce((a, b) => a + b, 0);
    if (progress === 0) return;
  }
}
