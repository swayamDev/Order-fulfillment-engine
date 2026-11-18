// Runs once before the integration suite: recreate the test schema from
// scratch, make sure the roles exist, then apply every migration as the owner.

import { sql } from 'kysely';
import { migrateToLatest } from '../src/migrate.ts';
import { ensureRoles } from '../src/roles.ts';
import { TEST_APP_PASSWORD, TEST_OWNER_URL, ownerDb } from './support.ts';

export default async function setup(): Promise<void> {
  await ensureRoles(TEST_OWNER_URL, TEST_APP_PASSWORD);
  const db = ownerDb(1);
  try {
    await sql`DROP SCHEMA public CASCADE`.execute(db);
    await sql`CREATE SCHEMA public`.execute(db);
    await migrateToLatest(db);
  } finally {
    await db.destroy();
  }
}
