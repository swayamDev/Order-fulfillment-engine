import { sql, type Kysely } from 'kysely';

// Shipping: Sethu's record of each shipment (sequenced like payments), the
// simulated courier's own table, courier chaos switches, and a reservation
// status for stock that was packed and then put back on the shelf.

const RLS_TABLES = ['shipments', 'sim_shipments'] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE shipments (
      shipment_id text PRIMARY KEY,
      sandbox_id  uuid NOT NULL REFERENCES sandboxes (id) ON DELETE CASCADE,
      order_id    uuid NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
      provider    text NOT NULL,
      status      text NOT NULL DEFAULT 'created'
                  CHECK (status IN ('created', 'in_transit', 'delivered', 'failed')),
      last_seq    integer NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
      created_at  timestamptz NOT NULL DEFAULT now(),
      updated_at  timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);
  await sql`CREATE INDEX shipments_order_idx ON shipments (order_id)`.execute(db);

  await sql`
    CREATE TABLE sim_shipments (
      id              text PRIMARY KEY,
      sandbox_id      uuid NOT NULL REFERENCES sandboxes (id) ON DELETE CASCADE,
      order_id        uuid NOT NULL,
      idempotency_key text NOT NULL,
      status          text NOT NULL CHECK (status IN ('booked', 'delivered', 'failed')),
      created_at      timestamptz NOT NULL DEFAULT now(),
      UNIQUE (sandbox_id, idempotency_key)
    )
  `.execute(db);

  for (const table of RLS_TABLES) {
    const t = sql.table(table);
    await sql`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`.execute(db);
    await sql`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`.execute(db);
    await sql`
      CREATE POLICY sandbox_isolation ON ${t}
        USING (sandbox_id = current_sandbox_id() OR current_user = 'sethu_system')
        WITH CHECK (sandbox_id = current_sandbox_id() OR current_user = 'sethu_system')
    `.execute(db);
    await sql`GRANT SELECT, INSERT, UPDATE, DELETE ON ${t} TO sethu_app, sethu_system`.execute(db);
  }

  await sql`
    ALTER TABLE chaos_settings
      ADD COLUMN courier_down boolean NOT NULL DEFAULT false,
      ADD COLUMN courier_fail_delivery boolean NOT NULL DEFAULT false
  `.execute(db);

  await sql`ALTER TABLE reservations DROP CONSTRAINT reservations_status_check`.execute(db);
  await sql`
    ALTER TABLE reservations ADD CONSTRAINT reservations_status_check
      CHECK (status IN ('held', 'released', 'consumed', 'returned'))
  `.execute(db);
}
