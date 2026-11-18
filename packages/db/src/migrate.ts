// Runs migrations as the owner role. The app role never runs DDL.

import { readdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import type { Kysely } from 'kysely';
import {
  Migrator,
  type Migration,
  type MigrationProvider,
  type MigrationResultSet,
} from 'kysely/migration';
import { createDb } from './client.ts';
import { requireEnv } from './env.ts';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

/**
 * Loads migrations through file:// URLs. Kysely's FileMigrationProvider imports
 * raw absolute paths, which Node's ESM loader rejects on Windows.
 */
class UrlMigrationProvider implements MigrationProvider {
  async getMigrations(): Promise<Record<string, Migration>> {
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.ts')).sort();
    const migrations: Record<string, Migration> = {};
    for (const file of files) {
      const url = pathToFileURL(path.join(MIGRATIONS_DIR, file)).href;
      migrations[file.replace(/\.ts$/, '')] = (await import(url)) as Migration;
    }
    return migrations;
  }
}

// Migrations accept a database of any schema; Kysely's own signature does the same.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function migrateToLatest(db: Kysely<any>): Promise<MigrationResultSet> {
  const migrator = new Migrator({ db, provider: new UrlMigrationProvider() });
  const result = await migrator.migrateToLatest();
  if (result.error !== undefined) {
    throw result.error instanceof Error
      ? result.error
      : new Error('Migration failed', { cause: result.error });
  }
  return result;
}

if (import.meta.main) {
  const db = createDb(requireEnv('DATABASE_OWNER_URL'));
  try {
    const { results = [] } = await migrateToLatest(db);
    for (const r of results) console.log(`${r.status}: ${r.migrationName}`);
    if (results.length === 0) console.log('Already up to date.');
  } finally {
    await db.destroy();
  }
}
