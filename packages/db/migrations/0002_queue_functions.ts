import { sql, type Kysely } from 'kysely';

// The queue's cross-sandbox surface. Each function is SECURITY DEFINER and owned
// by sethu_system (no login), so it passes the RLS policies; sethu_app may call
// them but cannot otherwise see across sandboxes. Job handlers never use these:
// they run as sethu_app inside withSandbox(job.sandbox_id).

export async function up(db: Kysely<unknown>): Promise<void> {
  // Claim up to p_limit due jobs from the given queues (a worker only claims
  // queues it has handlers for). SKIP LOCKED lets any number of workers claim
  // concurrently without blocking on, or double-claiming, the same rows.
  await sql`
    CREATE FUNCTION claim_jobs(
      p_worker text, p_queues text[], p_limit integer, p_lease_seconds integer
    )
    RETURNS SETOF jobs
    LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
    AS $$
      UPDATE jobs AS j
         SET status = 'running',
             attempts = j.attempts + 1,
             locked_by = p_worker,
             locked_until = now() + make_interval(secs => p_lease_seconds),
             updated_at = now()
        FROM (
          SELECT id FROM jobs
           WHERE status = 'queued' AND run_at <= now() AND queue = ANY (p_queues)
           ORDER BY run_at, id
           LIMIT p_limit
             FOR UPDATE SKIP LOCKED
        ) AS due
       WHERE j.id = due.id
      RETURNING j.*
    $$
  `.execute(db);

  // Return jobs whose worker stopped renewing its lease to the queue. A handler
  // that is still running holds a row lock on its job, so SKIP LOCKED leaves it
  // alone; only jobs of crashed or stalled workers come back.
  await sql`
    CREATE FUNCTION reap_expired_leases()
    RETURNS integer
    LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
    AS $$
      WITH expired AS (
        SELECT id FROM jobs
         WHERE status = 'running' AND locked_until < now()
           FOR UPDATE SKIP LOCKED
      ), reaped AS (
        UPDATE jobs AS j
           SET status = CASE WHEN j.attempts >= j.max_attempts THEN 'dead' ELSE 'queued' END,
               finished_at = CASE WHEN j.attempts >= j.max_attempts THEN now() END,
               run_at = now(),
               last_error = 'lease expired: worker ' || j.locked_by || ' stopped responding',
               locked_by = NULL,
               locked_until = NULL,
               updated_at = now()
          FROM expired
         WHERE j.id = expired.id
        RETURNING 1
      )
      SELECT count(*)::integer FROM reaped
    $$
  `.execute(db);

  // When the worker next has something to do: the earliest due job or expiring
  // lease. An idle worker sleeps until then, so Postgres can scale to zero.
  await sql`
    CREATE FUNCTION next_queue_wakeup(p_queues text[])
    RETURNS timestamptz
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
    AS $$
      SELECT least(
        (SELECT min(run_at) FROM jobs WHERE status = 'queued' AND queue = ANY (p_queues)),
        (SELECT min(locked_until) FROM jobs WHERE status = 'running')
      )
    $$
  `.execute(db);

  for (const fn of [
    sql`claim_jobs(text, text[], integer, integer)`,
    sql`reap_expired_leases()`,
    sql`next_queue_wakeup(text[])`,
  ]) {
    await sql`ALTER FUNCTION ${fn} OWNER TO sethu_system`.execute(db);
    await sql`REVOKE EXECUTE ON FUNCTION ${fn} FROM PUBLIC`.execute(db);
    await sql`GRANT EXECUTE ON FUNCTION ${fn} TO sethu_app`.execute(db);
  }
}
