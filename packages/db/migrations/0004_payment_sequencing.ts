import { sql, type Kysely } from 'kysely';

// Per-payment sequencing. Providers number the events of one payment
// (authorized = 1, captured = 2, and so on). Sethu applies them strictly in
// that order: last_seq is the highest sequence applied, an event further
// ahead is held until the gap fills, and one at or below it is ignored.

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE payments (
      intent_id  text PRIMARY KEY,
      sandbox_id uuid NOT NULL REFERENCES sandboxes (id) ON DELETE CASCADE,
      order_id   uuid NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
      provider   text NOT NULL,
      status     text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'authorized', 'captured', 'failed', 'refunded')),
      last_seq   integer NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);
  await sql`CREATE INDEX payments_order_idx ON payments (order_id)`.execute(db);
  await sql`ALTER TABLE payments ENABLE ROW LEVEL SECURITY`.execute(db);
  await sql`ALTER TABLE payments FORCE ROW LEVEL SECURITY`.execute(db);
  await sql`
    CREATE POLICY sandbox_isolation ON payments
      USING (sandbox_id = current_sandbox_id() OR current_user = 'sethu_system')
      WITH CHECK (sandbox_id = current_sandbox_id() OR current_user = 'sethu_system')
  `.execute(db);
  await sql`GRANT SELECT, INSERT, UPDATE, DELETE ON payments TO sethu_app, sethu_system`.execute(
    db,
  );

  // When an inbox event was first held for an earlier sequence.
  await sql`ALTER TABLE webhook_inbox ADD COLUMN held_at timestamptz`.execute(db);
}
