// Wires the modules together: which consumer reacts to which event, and which
// handler runs each queue. The only place that knows the whole flow.

import type { Db } from '@sethu/db';
import { RESERVE_INVENTORY, reserveInventory } from './modules/inventory/index.ts';
import { OutboxRelay, type Subscriptions } from './modules/outbox/index.ts';
import { Worker, type JobHandler, type WorkerOptions } from './modules/queue/index.ts';
import {
  DELIVER_SIM_PAYMENT_WEBHOOK,
  deliverSimPaymentWebhook,
  type SimPaymentsConfig,
} from './modules/sim-payments/index.ts';

export const SUBSCRIPTIONS: Subscriptions = new Map([['order.placed', [RESERVE_INVENTORY]]]);

export interface EngineDeps {
  /** The simulated payment provider's delivery worker runs here too. */
  readonly simPayments?: SimPaymentsConfig;
}

export function buildHandlers(deps: EngineDeps = {}): Map<string, JobHandler> {
  const handlers = new Map<string, JobHandler>([[RESERVE_INVENTORY, reserveInventory]]);
  if (deps.simPayments !== undefined) {
    handlers.set(DELIVER_SIM_PAYMENT_WEBHOOK, deliverSimPaymentWebhook(deps.simPayments));
  }
  return handlers;
}

/** Handlers with no external dependencies, for tests that only need the core flow. */
export const HANDLERS: ReadonlyMap<string, JobHandler> = buildHandlers();

export interface Engine {
  readonly relay: OutboxRelay;
  readonly workers: readonly Worker[];
  start(): void;
  stop(): Promise<void>;
  /** Wakes the relay and workers after new events or jobs commit. */
  notify(): void;
}

export interface EngineOptions extends EngineDeps {
  readonly workerCount?: number;
  readonly worker?: Partial<Pick<WorkerOptions, 'random' | 'backoff' | 'onError' | 'leaseSeconds'>>;
}

export function createEngine(db: Db, options: EngineOptions = {}): Engine {
  const handlers = buildHandlers(options);
  const workers = Array.from(
    { length: options.workerCount ?? 2 },
    (_, i) => new Worker({ db, id: `worker-${process.pid}-${i}`, handlers, ...options.worker }),
  );
  const wakeWorkers = () => {
    for (const worker of workers) worker.waker.notify();
  };
  const relay = new OutboxRelay({ db, subscriptions: SUBSCRIPTIONS, onPublished: wakeWorkers });
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
      wakeWorkers();
    },
  };
}

/** Runs relay and workers until nothing is due. For tests and scripts. */
export async function drain(engine: Pick<Engine, 'relay' | 'workers'>): Promise<void> {
  for (;;) {
    let progress = await engine.relay.runOnce();
    const claimed = await Promise.all(engine.workers.map((w) => w.runOnce()));
    progress += claimed.reduce((a, b) => a + b, 0);
    if (progress === 0) return;
  }
}
