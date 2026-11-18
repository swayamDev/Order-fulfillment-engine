import { sql, type Kysely } from 'kysely';

// Per-sandbox chaos switches for the public demo. The simulated providers read
// them when they schedule webhooks, so a visitor can make "the provider"
// misbehave and watch Sethu recover. They never affect another sandbox.

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE chaos_settings (
      sandbox_id                 uuid PRIMARY KEY REFERENCES sandboxes (id) ON DELETE CASCADE,
      payments_duplicate         boolean NOT NULL DEFAULT false,
      payments_reverse_order     boolean NOT NULL DEFAULT false,
      payments_drop_first        boolean NOT NULL DEFAULT false,
      payments_decline           boolean NOT NULL DEFAULT false,
      payments_extra_delay_ms    integer NOT NULL DEFAULT 0
                                 CHECK (payments_extra_delay_ms BETWEEN 0 AND 60000),
      updated_at                 timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);
  await sql`ALTER TABLE chaos_settings ENABLE ROW LEVEL SECURITY`.execute(db);
  await sql`ALTER TABLE chaos_settings FORCE ROW LEVEL SECURITY`.execute(db);
  await sql`
    CREATE POLICY sandbox_isolation ON chaos_settings
      USING (sandbox_id = current_sandbox_id() OR current_user = 'sethu_system')
      WITH CHECK (sandbox_id = current_sandbox_id() OR current_user = 'sethu_system')
  `.execute(db);
  await sql`GRANT SELECT, INSERT, UPDATE, DELETE ON chaos_settings TO sethu_app, sethu_system`.execute(
    db,
  );
}
