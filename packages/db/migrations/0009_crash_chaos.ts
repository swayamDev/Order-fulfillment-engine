import { sql, type Kysely } from 'kysely';

// Chaos: crash the worker that runs this sandbox's next step, mid-step.

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE chaos_settings ADD COLUMN crash_next_step boolean NOT NULL DEFAULT false`.execute(
    db,
  );
}
