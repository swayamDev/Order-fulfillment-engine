# ADR 001: Our own job queue on Postgres

Status: accepted, phase 1.

## Context

Sethu needs background jobs for every step after an order is placed: consumers of outbox events, webhook processing, and the simulated provider's webhook deliveries. Postgres is already the source of truth, and a job must be created in the same transaction as the change that causes it.

Three options were considered:

1. pg-boss
2. graphile-worker
3. A small queue of our own on `FOR UPDATE SKIP LOCKED`

## Decision

Build our own, deliberately small: queues, `run_at`, attempts, leases, backoff and a dead status. No cron, no priorities, no job dependencies.

## Why

- **Learning and explaining.** This is a portfolio project. Claiming, leasing, fencing and reaping are the parts worth being able to explain, and a library would hide them.
- **Same transaction as the outbox and the handler's effects.** Every option allows this, but with our own queue it is plain Kysely in one transaction, without a second client or schema to coordinate.
- **Neon scales to zero.** The free plan suspends compute after 5 minutes without queries and has a monthly compute budget. A worker that polls every second keeps it awake around the clock. graphile-worker relies on `LISTEN`/`NOTIFY`, which does not work through Neon's pooled endpoint and is lost when compute suspends. Our worker sleeps until the next due job or expiring lease (`next_queue_wakeup()`), or until the process wakes it in memory, so an idle demo lets the database sleep.
- **Row level security.** Claims must see every sandbox, while handlers must see only one. Owning the claim function let us make it the only cross-sandbox path (see ADR 002).

## How it works

- `claim_jobs(worker, queues, limit, lease)` marks due jobs `running` with `FOR UPDATE SKIP LOCKED`, so workers never block on, or both take, the same row. A worker only claims queues it has handlers for.
- A handler runs inside `withSandbox(job.sandbox_id)` as the app role. It first locks its own job row and checks it still holds the lease. That lock:
  - fences out a worker whose lease was reaped and given to someone else (it stops before any effect), and
  - stops the reaper, which uses `SKIP LOCKED`, from reclaiming a job that is still running.
- Success is recorded in the handler's transaction, so effects and completion commit together.
- On failure the job waits a random delay in `[0, min(cap, base * 2^(attempt - 1)))` (full jitter). After `max_attempts`, or at once for a `PermanentJobError`, it becomes `dead` with its reason, which is what the dead-letter page will list and replay.
- `reap_expired_leases()` returns crashed workers' jobs to the queue, or to `dead` if that was the last attempt.

## Costs we accept

- Correctness is ours to prove. The integration suite covers 8 workers racing for 1,000 jobs (each runs once), crash recovery, stale-worker fencing, a handler outliving its lease, backoff timing and dead-lettering.
- Throughput is far below a dedicated queue. Fine for a demo with per-sandbox caps.
- No scheduling features. If they are ever needed, graphile-worker is the likely replacement, and handlers would carry over mostly unchanged.
