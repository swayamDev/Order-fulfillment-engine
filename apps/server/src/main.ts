import { createDb } from '@sethu/db';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { createEngine } from './engine.ts';

const config = loadConfig();
const db = createDb(config.DATABASE_URL);
const engine = createEngine(db);
const app = await buildApp({
  config,
  db,
  logger: true,
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

engine.start();
await app.listen({ port: config.PORT, host: config.HOST });
