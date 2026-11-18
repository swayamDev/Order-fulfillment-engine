import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setSandbox, withSandbox, type Db } from '../src/client.ts';
import { createTestSandbox, seedProduct } from './fixtures.ts';
import { appDb, ownerDb } from './support.ts';

const RLS_VIOLATION = '42501';

let owner: Db;
let app: Db;
let sandboxA: string;
let sandboxB: string;

beforeAll(async () => {
  owner = ownerDb();
  app = appDb(1); // one connection, so a leaked setting would be visible
  sandboxA = await createTestSandbox(owner);
  sandboxB = await createTestSandbox(owner);
  await seedProduct(owner, sandboxA, 'SKU-A', 5);
  await seedProduct(owner, sandboxB, 'SKU-B', 5);
});

afterAll(async () => {
  await owner.destroy();
  await app.destroy();
});

async function errorCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

describe('row level security', () => {
  it('runs the app as a role that owns nothing and cannot bypass RLS', async () => {
    const { rows } = await sql<{
      rolsuper: boolean;
      rolbypassrls: boolean;
      owned: number;
    }>`
      SELECT r.rolsuper, r.rolbypassrls,
             (SELECT count(*)::int FROM pg_class c WHERE c.relowner = r.oid) AS owned
      FROM pg_roles r WHERE r.rolname = current_user
    `.execute(app);
    expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false, owned: 0 });
  });

  it('enables and forces RLS on every application table', async () => {
    const { rows } = await sql<{ relname: string; enabled: boolean; forced: boolean }>`
      SELECT relname, relrowsecurity AS enabled, relforcerowsecurity AS forced
      FROM pg_class
      WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'
        AND relname NOT LIKE 'kysely_%'
      ORDER BY relname
    `.execute(owner);
    expect(rows.length).toBeGreaterThanOrEqual(13);
    for (const row of rows) {
      expect(row, row.relname).toMatchObject({ enabled: true, forced: true });
    }
  });

  describe('without app.sandbox_id', () => {
    const tables = [
      'sandboxes',
      'products',
      'stock',
      'orders',
      'order_items',
      'order_events',
      'reservations',
      'outbox',
      'jobs',
      'processed_messages',
      'webhook_inbox',
      'sim_payment_intents',
      'payments',
    ] as const;

    for (const table of tables) {
      it(`returns no rows from ${table}`, async () => {
        const rows = await app.selectFrom(table).selectAll().execute();
        expect(rows).toEqual([]);
      });
    }

    it('cannot insert', async () => {
      const code = await errorCode(
        app
          .insertInto('products')
          .values({ sandbox_id: sandboxA, sku: 'SKU-X', name: 'x', price_minor: 1 })
          .execute(),
      );
      expect(code).toBe(RLS_VIOLATION);
    });

    it('cannot update or delete', async () => {
      const updated = await app
        .updateTable('stock')
        .set({ available: 0 })
        .executeTakeFirstOrThrow();
      const deleted = await app.deleteFrom('products').executeTakeFirstOrThrow();
      expect(updated.numUpdatedRows).toBe(0n);
      expect(deleted.numDeletedRows).toBe(0n);

      const stock = await withSandbox(app, sandboxA, (tx) =>
        tx.selectFrom('stock').select('available').executeTakeFirstOrThrow(),
      );
      expect(stock.available).toBe(5);
    });

    it('filters the table owner too, because RLS is forced', async () => {
      const rows = await owner.selectFrom('products').selectAll().execute();
      expect(rows).toEqual([]);
    });
  });

  describe('with app.sandbox_id set', () => {
    it("sees only its own sandbox's rows", async () => {
      const skus = await withSandbox(app, sandboxA, (tx) =>
        tx.selectFrom('products').select('sku').execute(),
      );
      expect(skus).toEqual([{ sku: 'SKU-A' }]);
    });

    it("cannot write into another sandbox's rows", async () => {
      const code = await errorCode(
        withSandbox(app, sandboxA, (tx) =>
          tx
            .insertInto('products')
            .values({ sandbox_id: sandboxB, sku: 'SKU-X', name: 'x', price_minor: 1 })
            .execute(),
        ),
      );
      expect(code).toBe(RLS_VIOLATION);
    });

    it('cannot move a row into another sandbox', async () => {
      const code = await errorCode(
        withSandbox(app, sandboxA, (tx) =>
          tx.updateTable('products').set({ sandbox_id: sandboxB }).execute(),
        ),
      );
      expect(code).toBe(RLS_VIOLATION);
    });

    it('does not leak the setting past the transaction', async () => {
      await withSandbox(app, sandboxA, (tx) => tx.selectFrom('products').selectAll().execute());
      const after = await app.selectFrom('products').selectAll().execute();
      expect(after).toEqual([]);
    });

    it('can switch scope inside one transaction', async () => {
      const seen = await app.transaction().execute(async (tx) => {
        await setSandbox(tx, sandboxA);
        const a = await tx.selectFrom('products').select('sku').execute();
        await setSandbox(tx, sandboxB);
        const b = await tx.selectFrom('products').select('sku').execute();
        return [...a, ...b];
      });
      expect(seen).toEqual([{ sku: 'SKU-A' }, { sku: 'SKU-B' }]);
    });
  });
});
