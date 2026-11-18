import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import pg from 'pg';
import type { Database } from './schema.ts';

// bigint columns (money in minor units) come back as JavaScript numbers. Every
// amount Sethu stores is far below Number.MAX_SAFE_INTEGER.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number(value));

export type Db = Kysely<Database>;
export type Tx = Transaction<Database>;

export function createDb(connectionString: string, max = 10): Db {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max }) }),
  });
}

/**
 * Runs `fn` in a transaction scoped to one sandbox. Row level security reads
 * app.sandbox_id, which SET LOCAL semantics clear again at commit or rollback,
 * so a pooled connection never leaks one visitor's scope into the next.
 */
export async function withSandbox<T>(
  db: Db,
  sandboxId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction().execute(async (tx) => {
    await setSandbox(tx, sandboxId);
    return fn(tx);
  });
}

/** Switches the sandbox scope inside an existing transaction. */
export async function setSandbox(tx: Tx, sandboxId: string): Promise<void> {
  await sql`SELECT set_config('app.sandbox_id', ${sandboxId}, true)`.execute(tx);
}
