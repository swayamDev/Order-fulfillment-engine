// The API process: HTTP API, simulated providers, outbox relay, and the
// supervisor for the worker processes (or in-process workers when
// WORKER_PROCESSES is 0).

import { createDb } from '@sethu/db';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { createEngine } from './engine.ts';
import { Supervisor, type WorkerExit } from './supervisor.ts';
import { buildProviders } from './wiring.ts';

const config = loadConfig();
const db = createDb(config.DATABASE_URL);
const providers = buildProviders(config);

const supervisor =
  config.WORKER_PROCESSES > 0 ? new Supervisor({ processes: config.WORKER_PROCESSES }) : undefined;

// Created before the engine so loop failures go to the same log.
let log: { error(obj: object, msg: string): void; warn(obj: object, msg: string): void } = {
  error: (obj, msg) => {
    console.error(msg, obj);
  },
  warn: (obj, msg) => {
    console.warn(msg, obj);
  },
};
const engine = createEngine(db, {
  ...providers,
  workerCount: supervisor === undefined ? config.WORKER_CONCURRENCY : 0,
  worker: { leaseSeconds: config.WORKER_LEASE_SECONDS },
  onWake: () => supervisor?.broadcast({ type: 'wake' }),
  onLoopError: (error) => {
    log.error({ err: error }, 'engine loop failed; retrying');
  },
});

supervisor?.on('message', (message: { type?: string }) => {
  if (message.type === 'committed') engine.notify();
});
supervisor?.on('exit', (exit: WorkerExit) => {
  if (stopping) return;
  log.warn(
    { slot: exit.slot, workerPid: exit.pid, code: exit.code, signal: exit.signal },
    'worker process exited; restarting',
  );
});

const app = await buildApp({
  config,
  db,
  logger: true,
  simPayments: providers.simPayments,
  simCourier: providers.simCourier,
  webhookSecrets: providers.webhookSecrets,
  onEventsCommitted: () => {
    engine.notify();
  },
});
log = app.log;

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  // Workers first, so none is restarted while the rest shuts down.
  await supervisor?.stop();
  await app.close();
  await engine.stop();
  await db.destroy();
};
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());

engine.start();
supervisor?.start();
await app.listen({ port: config.PORT, host: config.HOST });
