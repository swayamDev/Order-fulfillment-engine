import { sql, type Kysely } from 'kysely';

// Audit trail for dead-letter replays: who replayed which job, when, and what
// it had failed with. The job row itself is reset, so this is the history.

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE job_replays (
      id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      sandbox_id        uuid NOT NULL REFERENCES sandboxes (id) ON DELETE CASCADE,
      job_id            uuid NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
      queue             text NOT NULL,
      previous_error    text,
      previous_attempts integer NOT NULL,
      requested_by      text NOT NULL,
      replayed_at       timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);
  await sql`CREATE INDEX job_replays_job_idx ON job_replays (job_id)`.execute(db);
  await sql`ALTER TABLE job_replays ENABLE ROW LEVEL SECURITY`.execute(db);
  await sql`ALTER TABLE job_replays FORCE ROW LEVEL SECURITY`.execute(db);
  await sql`
    CREATE POLICY sandbox_isolation ON job_replays
      USING (sandbox_id = current_sandbox_id() OR current_user = 'sethu_system')
      WITH CHECK (sandbox_id = current_sandbox_id() OR current_user = 'sethu_system')
  `.execute(db);
  await sql`GRANT SELECT, INSERT, UPDATE, DELETE ON job_replays TO sethu_app, sethu_system`.execute(
    db,
  );
}
