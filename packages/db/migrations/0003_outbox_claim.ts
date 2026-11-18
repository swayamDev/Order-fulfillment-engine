import { sql, type Kysely } from 'kysely';

// The outbox relay's only cross-sandbox step: find unpublished events in any
// sandbox. FOR UPDATE SKIP LOCKED keeps the returned rows locked until the
// caller's transaction ends, so concurrent relays never take the same event.
// Fanning the event out to jobs then happens as sethu_app, scoped per event.

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE FUNCTION claim_outbox(p_limit integer)
    RETURNS SETOF outbox
    LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
    AS $$
      SELECT * FROM outbox
       WHERE published_at IS NULL
       ORDER BY created_at, id
       LIMIT p_limit
         FOR UPDATE SKIP LOCKED
    $$
  `.execute(db);
  await sql`ALTER FUNCTION claim_outbox(integer) OWNER TO sethu_system`.execute(db);
  await sql`REVOKE EXECUTE ON FUNCTION claim_outbox(integer) FROM PUBLIC`.execute(db);
  await sql`GRANT EXECUTE ON FUNCTION claim_outbox(integer) TO sethu_app`.execute(db);
}
