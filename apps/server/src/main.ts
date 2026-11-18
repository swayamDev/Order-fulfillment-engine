import { createDb } from '@sethu/db';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';

const config = loadConfig();
const db = createDb(config.DATABASE_URL);
const app = await buildApp({ config, db, logger: true });

const shutdown = async () => {
  await app.close();
  await db.destroy();
};
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());

await app.listen({ port: config.PORT, host: config.HOST });
