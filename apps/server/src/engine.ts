// Wires the modules together: which consumer reacts to which event, and which
// handler runs each queue. The only place that knows the whole flow.

import type { Db } from '@sethu/db';
import {
  COMPENSATE_CANCELLED,
  COMPENSATE_PAYMENT_FAILED,
  COMPENSATE_SHIPMENT_FAILED,
  compensateCancelled,
  compensatePaymentFailed,
  compensateShipmentFailed,
} from './modules/compensation/index.ts';
import { RESERVE_INVENTORY, reserveInventory } from './modules/inventory/index.ts';
import { OutboxRelay, type Subscriptions } from './modules/outbox/index.ts';
import {
  applyPaymentWebhook,
  REFUND_PAYMENT,
  refundPayment,
  REQUEST_PAYMENT,
  requestPayment,
  type PaymentsClient,
} from './modules/payments/index.ts';
import { Worker, type JobHandler, type WorkerOptions } from './modules/queue/index.ts';
import {
  applyCourierWebhook,
  PACK_ORDER,
  packOrder,
  SHIP_ORDER,
  shipOrder,
  type CourierClient,
} from './modules/shipping/index.ts';
import {
  DELIVER_SIM_COURIER_WEBHOOK,
  deliverSimCourierWebhook,
  SIM_COURIER,
  type SimCourierConfig,
} from './modules/sim-courier/index.ts';
import {
  DELIVER_SIM_PAYMENT_WEBHOOK,
  deliverSimPaymentWebhook,
  SIM_PAYMENTS,
  type SimPaymentsConfig,
} from './modules/sim-payments/index.ts';
import { PROCESS_WEBHOOK, processWebhook } from './modules/webhooks/index.ts';

/** Which consumers react to which order events. */
export const SUBSCRIPTIONS: Subscriptions = new Map([
  ['order.placed', [RESERVE_INVENTORY]],
  ['order.inventory_reserved', [REQUEST_PAYMENT]],
  ['order.payment_failed', [COMPENSATE_PAYMENT_FAILED]],
  ['order.paid', [PACK_ORDER]],
  ['order.packed', [SHIP_ORDER]],
  ['order.shipment_failed', [COMPENSATE_SHIPMENT_FAILED]],
  ['order.cancelled', [COMPENSATE_CANCELLED]],
]);

export interface EngineDeps {
  /** Client for the payment provider; without it no payment is requested. */
  readonly payments?: PaymentsClient;
  /**
   * Client for the courier. Fulfillment (packing and shipping) runs only when
   * one is configured; without it, paid orders wait at paid.
   */
  readonly courier?: CourierClient;
  /** The simulated providers' delivery workers run in the engine too. */
  readonly simPayments?: SimPaymentsConfig;
  readonly simCourier?: SimCourierConfig;
}

export function buildHandlers(deps: EngineDeps = {}): Map<string, JobHandler> {
  const processors = new Map([
    [SIM_PAYMENTS, applyPaymentWebhook],
    [SIM_COURIER, applyCourierWebhook],
  ]);
  const handlers = new Map<string, JobHandler>([
    [RESERVE_INVENTORY, reserveInventory],
    [COMPENSATE_PAYMENT_FAILED, compensatePaymentFailed],
    [COMPENSATE_CANCELLED, compensateCancelled],
    [COMPENSATE_SHIPMENT_FAILED, compensateShipmentFailed],
    [PROCESS_WEBHOOK, processWebhook(processors)],
  ]);
  if (deps.payments !== undefined) {
    handlers.set(REQUEST_PAYMENT, requestPayment(deps.payments));
    handlers.set(REFUND_PAYMENT, refundPayment(deps.payments));
  }
  if (deps.courier !== undefined) {
    handlers.set(PACK_ORDER, packOrder);
    handlers.set(SHIP_ORDER, shipOrder(deps.courier));
  }
  if (deps.simPayments !== undefined) {
    handlers.set(DELIVER_SIM_PAYMENT_WEBHOOK, deliverSimPaymentWebhook(deps.simPayments));
  }
  if (deps.simCourier !== undefined) {
    handlers.set(DELIVER_SIM_COURIER_WEBHOOK, deliverSimCourierWebhook(deps.simCourier));
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
  readonly worker?: Partial<
    Pick<WorkerOptions, 'random' | 'backoff' | 'onError' | 'onLoopError' | 'leaseSeconds'>
  >;
  /** Where loop failures are reported (the server passes its logger). */
  readonly onLoopError?: (error: unknown) => void;
}

export function createEngine(db: Db, options: EngineOptions = {}): Engine {
  const handlers = buildHandlers(options);
  const wakeWorkers = () => {
    for (const worker of workers) worker.waker.notify();
  };
  const wakeAll = () => {
    relay.waker.notify();
    wakeWorkers();
  };
  const workers: Worker[] = Array.from(
    { length: options.workerCount ?? 2 },
    (_, i) =>
      new Worker({
        db,
        id: `worker-${process.pid}-${i}`,
        handlers,
        onCommitted: wakeAll,
        ...(options.onLoopError === undefined ? {} : { onLoopError: options.onLoopError }),
        ...options.worker,
      }),
  );
  const relay = new OutboxRelay({
    db,
    subscriptions: SUBSCRIPTIONS,
    onPublished: wakeWorkers,
    ...(options.onLoopError === undefined ? {} : { onLoopError: options.onLoopError }),
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
    notify: wakeAll,
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
