import { withSandbox, type Db, type Job, type Tx } from '@sethu/db';
import { sql } from 'kysely';
import { Waker } from './waker.ts';

export type JobHandler = (tx: Tx, job: Job) => Promise<void>;

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
    while (!this.stopped) {
      const claimed = await this.runOnce();
      if (claimed > 0) continue;
      await this.reap();
      await this.waker.sleep(await this.idleDelayMs());
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
        await handler(tx, job);
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
      });
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

  private async recordFailure(job: Job, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await withSandbox(this.db, job.sandbox_id, async (tx) => {
      await tx
        .updateTable('jobs')
        .set({
          status: 'queued',
          run_at: sql<Date>`now() + interval '1 second'`,
          last_error: message.slice(0, 2000),
          locked_by: null,
          locked_until: null,
          updated_at: sql<Date>`now()`,
        })
        .where('id', '=', job.id)
        .where('status', '=', 'running')
        .where('locked_by', '=', this.id)
        .execute();
    });
  }
}
