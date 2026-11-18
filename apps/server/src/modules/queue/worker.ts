import { withSandbox, type Db, type Job, type Tx } from '@sethu/db';
import { sql } from 'kysely';
import { backoffDelayMs, DEFAULT_BACKOFF, type BackoffPolicy } from './backoff.ts';
import { Waker } from './waker.ts';

/** How long a failing loop waits before trying the database again. */
export const LOOP_BACKOFF: BackoffPolicy = { baseMs: 500, capMs: 30_000 };

/**
 * What a handler can ask for besides success. Either is committed in the
 * handler's own transaction, together with anything it wrote first (such as a
 * "held" note on an order's timeline).
 */
export type JobOutcome =
  | { readonly kind: 'retry'; readonly reason: string }
  | { readonly kind: 'dead'; readonly reason: string };

/** Try again after the usual backoff; dead-letter once attempts run out. */
export const retryLater = (reason: string): JobOutcome => ({ kind: 'retry', reason });
/** Give up now and put the job in the dead-letter queue with this reason. */
export const deadLetter = (reason: string): JobOutcome => ({ kind: 'dead', reason });

// Handlers that simply succeed are plain async functions returning void.
// eslint-disable-next-line @typescript-eslint/no-invalid-void-type
export type JobHandler = (tx: Tx, job: Job) => Promise<void | JobOutcome>;

export interface WorkerOptions {
  readonly db: Db;
  readonly id: string;
  readonly handlers: ReadonlyMap<string, JobHandler>;
  readonly leaseSeconds?: number;
  readonly batchSize?: number;
  /** Longest an idle worker sleeps without being woken. */
  readonly maxIdleMs?: number;
  readonly waker?: Waker;
  readonly onError?: (error: unknown, job: Job) => void;
  /**
   * Called after a job's transaction commits. Handlers may have written outbox
   * events or new jobs, so the engine uses this to wake the relay and workers.
   */
  readonly onCommitted?: (job: Job) => void;
  /** Called when claiming or reaping fails; the loop then waits and retries. */
  readonly onLoopError?: (error: unknown) => void;
  readonly backoff?: BackoffPolicy;
  /** Source of jitter. Tests pass a fixed function. */
  readonly random?: () => number;
}

/**
 * Thrown by a handler when retrying cannot help (a malformed payload, an event
 * that can never apply). The job goes straight to the dead-letter queue with
 * this message as its reason.
 */
export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentJobError';
  }
}

/** The worker's lease on a job was taken over; its transaction must not commit. */
export class LeaseLostError extends Error {
  constructor(jobId: string) {
    super(`Lease on job ${jobId} was lost`);
    this.name = 'LeaseLostError';
  }
}

export class Worker {
  readonly id: string;
  readonly waker: Waker;
  private readonly db: Db;
  private readonly handlers: ReadonlyMap<string, JobHandler>;
  /** A worker only ever claims jobs it has a handler for. */
  private readonly queues: string[];
  private readonly leaseSeconds: number;
  private readonly batchSize: number;
  private readonly maxIdleMs: number;
  private readonly onError: (error: unknown, job: Job) => void;
  private readonly onLoopError: (error: unknown) => void;
  private readonly onCommitted: (job: Job) => void;
  private readonly backoff: BackoffPolicy;
  private readonly random: () => number;
  private running: Promise<void> | undefined;
  private stopped = false;

  constructor(options: WorkerOptions) {
    this.db = options.db;
    this.id = options.id;
    this.handlers = options.handlers;
    this.queues = [...options.handlers.keys()];
    this.leaseSeconds = options.leaseSeconds ?? 30;
    this.batchSize = options.batchSize ?? 10;
    this.maxIdleMs = options.maxIdleMs ?? 30 * 60_000;
    this.waker = options.waker ?? new Waker();
    this.onError = options.onError ?? (() => undefined);
    this.onLoopError = options.onLoopError ?? (() => undefined);
    this.onCommitted = options.onCommitted ?? (() => undefined);
    this.backoff = options.backoff ?? DEFAULT_BACKOFF;
    this.random = options.random ?? Math.random;
  }

  /** Claims one batch and processes it. Returns how many jobs it claimed. */
  async runOnce(): Promise<number> {
    const { rows: jobs } = await sql<Job>`
      SELECT * FROM claim_jobs(${this.id}, ${this.queues}, ${this.batchSize}, ${this.leaseSeconds})
    `.execute(this.db);
    for (const job of jobs) await this.process(job);
    return jobs.length;
  }

  /** Requeues jobs whose workers died. Returns how many it reaped. */
  async reap(): Promise<number> {
    const { rows } = await sql<{ n: number }>`SELECT reap_expired_leases() AS n`.execute(this.db);
    return rows[0]?.n ?? 0;
  }

  start(): void {
    this.stopped = false;
    this.running ??= this.loop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.waker.notify();
    await this.running;
    this.running = undefined;
  }

  private async loop(): Promise<void> {
    let failures = 0;
    while (!this.stopped) {
      try {
        const claimed = await this.runOnce();
        failures = 0;
        if (claimed > 0) continue;
        await this.reap();
        await this.waker.sleep(await this.idleDelayMs());
      } catch (error) {
        // The database went away (a dropped connection, Neon resuming from
        // zero). Keep the process alive and try again after a pause.
        failures++;
        this.onLoopError(error);
        await this.waker.sleep(backoffDelayMs(failures, LOOP_BACKOFF) + 100);
      }
    }
  }

  private async idleDelayMs(): Promise<number> {
    const { rows } = await sql<{ ms: number | null }>`
      SELECT (extract(epoch FROM next_queue_wakeup(${this.queues}) - now()) * 1000)::float8 AS ms
    `.execute(this.db);
    const ms = rows[0]?.ms ?? null;
    if (ms === null) return this.maxIdleMs;
    return Math.min(Math.max(ms, 0), this.maxIdleMs);
  }

  /** Runs one claimed job. The loop calls this; tests call it to replay a stale claim. */
  async process(job: Job): Promise<void> {
    const handler = this.handlers.get(job.queue);
    try {
      if (handler === undefined) throw new Error(`No handler for queue ${job.queue}`);
      await withSandbox(this.db, job.sandbox_id, async (tx) => {
        await this.holdLease(tx, job);
        const outcome = await handler(tx, job);
        await this.settle(tx, job, outcome ?? undefined);
      });
      this.onCommitted(job);
    } catch (error) {
      if (error instanceof LeaseLostError) return;
      this.onError(error, job);
      await this.recordFailure(job, error);
    }
  }

  /**
   * Locks the job row for the rest of the handler's transaction, and checks we
   * still own it. While the lock is held the reaper skips this job; if the
   * lease was already reaped and claimed elsewhere, we stop before any effect.
   */
  private async holdLease(tx: Tx, job: Job): Promise<void> {
    const row = await tx
      .selectFrom('jobs')
      .select('id')
      .where('id', '=', job.id)
      .where('status', '=', 'running')
      .where('locked_by', '=', this.id)
      .forUpdate()
      .executeTakeFirst();
    if (row === undefined) throw new LeaseLostError(job.id);
  }

  /**
   * Records how the job ended. Without an outcome it succeeded. A retry waits
   * a jittered backoff, unless attempts are used up, in which case it joins
   * the dead-letter queue like an explicit dead outcome.
   */
  private async settle(tx: Tx, job: Job, outcome: JobOutcome | undefined): Promise<void> {
    if (outcome === undefined) {
      await tx
        .updateTable('jobs')
        .set({
          status: 'succeeded',
          locked_by: null,
          locked_until: null,
          last_error: null,
          finished_at: sql<Date>`now()`,
          updated_at: sql<Date>`now()`,
        })
        .where('id', '=', job.id)
        .execute();
      return;
    }
    const exhausted = outcome.kind === 'retry' && job.attempts >= job.max_attempts;
    const dead = outcome.kind === 'dead' || exhausted;
    const reason = exhausted
      ? `gave up after ${job.attempts} attempts: ${outcome.reason}`
      : outcome.reason;
    const delayMs = dead ? 0 : backoffDelayMs(job.attempts, this.backoff, this.random);
    await tx
      .updateTable('jobs')
      .set({
        status: dead ? 'dead' : 'queued',
        run_at: sql<Date>`now() + make_interval(secs => ${delayMs / 1000})`,
        finished_at: dead ? sql<Date>`now()` : null,
        last_error: reason.slice(0, 2000),
        locked_by: null,
        locked_until: null,
        updated_at: sql<Date>`now()`,
      })
      .where('id', '=', job.id)
      .where('status', '=', 'running')
      .where('locked_by', '=', this.id)
      .execute();
  }

  /** The handler threw: its transaction rolled back, so settle in a new one. */
  private async recordFailure(job: Job, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const outcome = error instanceof PermanentJobError ? deadLetter(message) : retryLater(message);
    await withSandbox(this.db, job.sandbox_id, (tx) => this.settle(tx, job, outcome));
  }
}
