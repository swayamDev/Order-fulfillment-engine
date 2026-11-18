import { sql, type Kysely } from 'kysely';

// Refunds. The simulated provider numbers a payment's events itself, so it
// needs to remember the next sequence it will use (a refund comes after
// authorized and captured, or after failed).

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE sim_payment_intents ADD COLUMN next_sequence integer NOT NULL DEFAULT 1`.execute(
    db,
  );
  await sql`ALTER TABLE sim_payment_intents ADD COLUMN refunded_at timestamptz`.execute(db);
  await sql`ALTER TABLE sim_payment_intents DROP CONSTRAINT sim_payment_intents_status_check`.execute(
    db,
  );
  await sql`
    ALTER TABLE sim_payment_intents ADD CONSTRAINT sim_payment_intents_status_check
      CHECK (status IN ('authorized', 'captured', 'failed', 'refunded'))
  `.execute(db);
}
