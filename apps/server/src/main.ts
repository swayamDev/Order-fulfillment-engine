import { createDb } from '@sethu/db';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { createEngine } from './engine.ts';
import { httpPaymentsClient } from './modules/payments/index.ts';
import type { SimPaymentsConfig } from './modules/sim-payments/index.ts';

const config = loadConfig();
const db = createDb(config.DATABASE_URL);

const [signingSecret] = config.SIM_PAYMENTS_WEBHOOK_SECRETS;
if (signingSecret === undefined) throw new Error('SIM_PAYMENTS_WEBHOOK_SECRETS is empty');
const simPayments: SimPaymentsConfig = {
  apiKey: config.SIM_PAYMENTS_API_KEY,
  signingSecret,
  webhookUrl: () => `${config.PUBLIC_API_URL}/v1/webhooks/sim-payments`,
  delayMs: config.SIM_PAYMENTS_DELAY_MS,
};

const payments = httpPaymentsClient({
  baseUrl: () => `${config.PUBLIC_API_URL}/sim/payments`,
  apiKey: config.SIM_PAYMENTS_API_KEY,
});

// Created before the engine so loop failures go to the same log.
let logLoopError: (error: unknown) => void = (error) => {
  console.error(error);
};
const engine = createEngine(db, {
  simPayments,
  payments,
  onLoopError: (error) => {
    logLoopError(error);
  },
});
const app = await buildApp({
  config,
  db,
  logger: true,
  simPayments,
  webhookSecrets: new Map([['sim-payments', config.SIM_PAYMENTS_WEBHOOK_SECRETS]]),
  onEventsCommitted: () => {
    engine.notify();
  },
});

const shutdown = async () => {
  await app.close();
  await engine.stop();
  await db.destroy();
};
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());

logLoopError = (error) => {
  app.log.error({ err: error }, 'engine loop failed; retrying');
};
engine.start();
await app.listen({ port: config.PORT, host: config.HOST });
