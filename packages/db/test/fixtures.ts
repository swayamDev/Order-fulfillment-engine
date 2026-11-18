import { randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { withSandbox, type Db } from '../src/client.ts';

/**
 * Creates a sandbox directly, for tests. Row level security applies to the
 * owner too, so the insert runs with app.sandbox_id already set to the new id.
 */
export async function createTestSandbox(db: Db): Promise<string> {
  const id = randomUUID();
  await withSandbox(db, id, async (tx) => {
    await tx
      .insertInto('sandboxes')
      .values({
        id,
        token_hash: randomBytes(32),
        expires_at: sql<Date>`now() + interval '2 hours'`,
        hard_expires_at: sql<Date>`now() + interval '6 hours'`,
      })
      .execute();
  });
  return id;
}

export async function seedProduct(
  db: Db,
  sandboxId: string,
  sku: string,
  available: number,
  priceMinor = 1000,
): Promise<void> {
  await withSandbox(db, sandboxId, async (tx) => {
    await tx
      .insertInto('products')
      .values({ sandbox_id: sandboxId, sku, name: `Test ${sku}`, price_minor: priceMinor })
      .execute();
    await tx.insertInto('stock').values({ sandbox_id: sandboxId, sku, available }).execute();
  });
}
