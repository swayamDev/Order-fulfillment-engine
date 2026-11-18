import { withSandbox, type Db, type Job } from '@sethu/db';
import { appDb, createTestSandbox, ownerDb, seedProduct } from '@sethu/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  enqueue,
  PermanentJobError,
  Worker,
  type JobHandler,
} from '../../src/modules/queue/index.ts';

let db: Db;
let owner: Db;

beforeAll(() => {
  db = appDb(12);
  owner = ownerDb();
});

afterAll(async () => {
  await db.destroy();
  await owner.destroy();
});

async function addJobs(sandboxId: string, queue: string, count: number, delayMs = 0) {
  await withSandbox(db, sandboxId, async (tx) => {
    for (let i = 0; i < count; i++) {
      await enqueue(tx, { sandboxId, queue, payload: { i }, delayMs });
    }
  });
}

async function jobsIn(sandboxId: string, queue: string): Promise<Job[]> {
  return withSandbox(owner, sandboxId, (tx) =>
    tx.selectFrom('jobs').selectAll().where('queue', '=', queue).execute(),
  );
}

/** Claims a job without processing it, like a worker that then crashes or stalls. */
async function claimAs(worker: string, queue: string): Promise<Job[]> {
  const { rows } = await sql<Job>`
    SELECT * FROM claim_jobs(${worker}, ${[queue]}, 1, 30)
  `.execute(db);
  return rows;
}

async function expireLease(job: Job) {
  await withSandbox(owner, job.sandbox_id, (tx) =>
    tx
      .updateTable('jobs')
      .set({ locked_until: sql<Date>`now() - interval '1 second'` })
      .where('id', '=', job.id)
      .execute(),
  );
}

const handlers = (entries: Record<string, JobHandler>) => new Map(Object.entries(entries));

describe('job queue', () => {
  it('runs each of 1,000 jobs exactly once with 8 workers racing', async () => {
    const sandboxes = await Promise.all([1, 2, 3].map(() => createTestSandbox(owner)));
    for (const [i, sandbox] of sandboxes.entries())
      await addJobs(sandbox, 'race', i === 0 ? 334 : 333);

    const runs = new Map<string, number>();
    const handler: JobHandler = async (tx, job) => {
      runs.set(job.id, (runs.get(job.id) ?? 0) + 1);
      // A second run of the same job would violate this primary key.
      await tx
        .insertInto('processed_messages')
        .values({ consumer: 'race', message_id: job.id, sandbox_id: job.sandbox_id })
        .execute();
    };
    const workers = Array.from(
      { length: 8 },
      (_, i) =>
        new Worker({ db, id: `race-${i}`, handlers: handlers({ race: handler }), batchSize: 5 }),
    );
    await Promise.all(
      workers.map(async (worker) => {
        while ((await worker.runOnce()) > 0) {
          /* keep claiming */
        }
      }),
    );

    expect(runs.size).toBe(1000);
    expect([...runs.values()].every((n) => n === 1)).toBe(true);
    for (const sandbox of sandboxes) {
      const jobs = await jobsIn(sandbox, 'race');
      expect(jobs.every((j) => j.status === 'succeeded' && j.attempts === 1)).toBe(true);
    }
  });

  it('does not claim jobs before their run_at', async () => {
    const sandbox = await createTestSandbox(owner);
    await addJobs(sandbox, 'later', 1, 60_000);
    const worker = new Worker({
      db,
      id: 'later',
      handlers: handlers({ later: () => Promise.resolve() }),
    });
    expect(await worker.runOnce()).toBe(0);
    const [job] = await jobsIn(sandbox, 'later');
    expect(job?.status).toBe('queued');
  });

  it("reclaims a crashed worker's job after its lease expires", async () => {
    const sandbox = await createTestSandbox(owner);
    await addJobs(sandbox, 'crash', 1);
    const [claimed] = await claimAs('crashed-worker', 'crash');
    if (claimed === undefined) throw new Error('nothing claimed');
    // The crashed worker never finishes. Its lease runs out.
    await expireLease(claimed);

    const survivor = new Worker({
      db,
      id: 'survivor',
      handlers: handlers({ crash: () => Promise.resolve() }),
    });
    expect(await survivor.reap()).toBe(1);
    const [requeued] = await jobsIn(sandbox, 'crash');
    expect(requeued).toMatchObject({ status: 'queued', attempts: 1, locked_by: null });
    expect(requeued?.last_error).toContain('crashed-worker stopped responding');

    expect(await survivor.runOnce()).toBe(1);
    const [done] = await jobsIn(sandbox, 'crash');
    expect(done).toMatchObject({ status: 'succeeded', attempts: 2, last_error: null });
  });

  it('dead-letters a job whose lease expires on its final attempt', async () => {
    const sandbox = await createTestSandbox(owner);
    await withSandbox(db, sandbox, (tx) =>
      enqueue(tx, { sandboxId: sandbox, queue: 'last-try', payload: {}, maxAttempts: 1 }),
    );
    const [claimed] = await claimAs('doomed', 'last-try');
    if (claimed === undefined) throw new Error('nothing claimed');
    await expireLease(claimed);
    await new Worker({ db, id: 'reaper', handlers: handlers({}) }).reap();
    const [job] = await jobsIn(sandbox, 'last-try');
    expect(job?.status).toBe('dead');
    expect(job?.finished_at).not.toBeNull();
  });

  it('stops a worker whose lease was taken over before it changes anything', async () => {
    const sandbox = await createTestSandbox(owner);
    await addJobs(sandbox, 'fenced', 1);
    const [stale] = await claimAs('slow-worker', 'fenced');
    if (stale === undefined) throw new Error('nothing claimed');
    await expireLease(stale);
    const ran: string[] = [];
    const record =
      (who: string): JobHandler =>
      async () => {
        ran.push(who);
        return Promise.resolve();
      };

    const fast = new Worker({
      db,
      id: 'fast-worker',
      handlers: handlers({ fenced: record('fast') }),
    });
    await fast.reap();
    expect(await fast.runOnce()).toBe(1);

    // The slow worker wakes up and tries to finish its old claim.
    const slow = new Worker({
      db,
      id: 'slow-worker',
      handlers: handlers({ fenced: record('slow') }),
    });
    await slow.process(stale);

    expect(ran).toEqual(['fast']);
    const [job] = await jobsIn(sandbox, 'fenced');
    expect(job).toMatchObject({ status: 'succeeded', locked_by: null });
  });

  it('never reaps a job whose handler is still running, even past its lease', async () => {
    const sandbox = await createTestSandbox(owner);
    await addJobs(sandbox, 'long', 1);
    let reapedWhileRunning = -1;
    const worker: Worker = new Worker({
      db,
      id: 'long-runner',
      leaseSeconds: 1,
      handlers: handlers({
        long: async () => {
          // Outlive the 1 second lease while holding the job's row lock.
          await new Promise((resolve) => setTimeout(resolve, 1_500));
          reapedWhileRunning = await worker.reap();
        },
      }),
    });
    expect(await worker.runOnce()).toBe(1);
    expect(reapedWhileRunning).toBe(0);
    const [job] = await jobsIn(sandbox, 'long');
    expect(job?.status).toBe('succeeded');
  });

  it('requeues a failed job with the error recorded', async () => {
    const sandbox = await createTestSandbox(owner);
    await addJobs(sandbox, 'flaky', 1);
    const errors: unknown[] = [];
    const worker = new Worker({
      db,
      id: 'flaky',
      handlers: handlers({ flaky: () => Promise.reject(new Error('courier timed out')) }),
      onError: (error) => errors.push(error),
    });
    expect(await worker.runOnce()).toBe(1);
    const [job] = await jobsIn(sandbox, 'flaky');
    expect(job).toMatchObject({ status: 'queued', attempts: 1, last_error: 'courier timed out' });
    expect(errors).toHaveLength(1);
  });

  it('waits a jittered, exponentially growing delay between attempts', async () => {
    const sandbox = await createTestSandbox(owner);
    await addJobs(sandbox, 'slow-retry', 1);
    const worker = new Worker({
      db,
      id: 'slow-retry',
      handlers: handlers({ 'slow-retry': () => Promise.reject(new Error('503 from courier')) }),
      backoff: { baseMs: 1_000, capMs: 60_000 },
      random: () => 0.999_999,
    });
    expect(await worker.runOnce()).toBe(1);
    const delay = await withSandbox(owner, sandbox, (tx) =>
      tx
        .selectFrom('jobs')
        .select(sql<number>`extract(epoch FROM run_at - updated_at)::float8`.as('seconds'))
        .where('queue', '=', 'slow-retry')
        .executeTakeFirstOrThrow(),
    );
    expect(delay.seconds).toBeGreaterThan(0.9);
    expect(delay.seconds).toBeLessThan(1.0);
  });

  it('dead-letters a job after its last attempt fails', async () => {
    const sandbox = await createTestSandbox(owner);
    await withSandbox(db, sandbox, (tx) =>
      enqueue(tx, { sandboxId: sandbox, queue: 'doomed', payload: {}, maxAttempts: 3 }),
    );
    const worker = new Worker({
      db,
      id: 'doomed',
      handlers: handlers({ doomed: () => Promise.reject(new Error('card declined')) }),
      random: () => 0, // retry immediately so the test does not wait
    });
    for (let i = 0; i < 3; i++) expect(await worker.runOnce()).toBe(1);
    expect(await worker.runOnce()).toBe(0);

    const [job] = await jobsIn(sandbox, 'doomed');
    expect(job).toMatchObject({
      status: 'dead',
      attempts: 3,
      last_error: 'gave up after 3 attempts: card declined',
    });
    expect(job?.finished_at).not.toBeNull();
  });

  it('dead-letters at once when retrying cannot help', async () => {
    const sandbox = await createTestSandbox(owner);
    await addJobs(sandbox, 'hopeless', 1);
    const worker = new Worker({
      db,
      id: 'hopeless',
      handlers: handlers({
        hopeless: () => Promise.reject(new PermanentJobError('payload is missing order_id')),
      }),
    });
    expect(await worker.runOnce()).toBe(1);
    const [job] = await jobsIn(sandbox, 'hopeless');
    expect(job).toMatchObject({
      status: 'dead',
      attempts: 1,
      last_error: 'payload is missing order_id',
    });
  });

  it('only deduplicates jobs within a sandbox', async () => {
    const a = await createTestSandbox(owner);
    const b = await createTestSandbox(owner);
    const add = (sandboxId: string) =>
      withSandbox(db, sandboxId, (tx) =>
        enqueue(tx, { sandboxId, queue: 'dedupe', payload: {}, dedupeKey: 'event-1:consumer' }),
      );
    expect(await add(a)).toBe(true);
    expect(await add(a)).toBe(false);
    expect(await add(b)).toBe(true);
  });
});

describe('job handlers run as sethu_app inside their own sandbox', () => {
  let a: string;
  let b: string;

  beforeAll(async () => {
    a = await createTestSandbox(owner);
    b = await createTestSandbox(owner);
    await seedProduct(owner, a, 'A-ONLY', 5);
    await seedProduct(owner, b, 'B-ONLY', 5);
  });

  it("cannot read or update another sandbox's rows", async () => {
    const seen: Record<string, unknown> = {};
    const worker = new Worker({
      db,
      id: 'isolated',
      handlers: handlers({
        peek: async (tx) => {
          const { rows } = await sql<{ role: string; sandbox: string }>`
            SELECT current_user AS role, current_setting('app.sandbox_id') AS sandbox
          `.execute(tx);
          seen['who'] = rows[0];
          seen['skus'] = await tx.selectFrom('products').select('sku').execute();
          const updated = await tx
            .updateTable('stock')
            .set({ available: 0 })
            .where('sandbox_id', '=', b)
            .executeTakeFirstOrThrow();
          seen['updatedInB'] = updated.numUpdatedRows;
        },
      }),
    });
    await addJobs(a, 'peek', 1);
    expect(await worker.runOnce()).toBe(1);

    expect(seen).toEqual({
      who: { role: 'sethu_app', sandbox: a },
      skus: [{ sku: 'A-ONLY' }],
      updatedInB: 0n,
    });
    const stockB = await withSandbox(owner, b, (tx) =>
      tx.selectFrom('stock').select('available').executeTakeFirstOrThrow(),
    );
    expect(stockB.available).toBe(5);
  });

  it('cannot insert into another sandbox, and the job fails instead of succeeding', async () => {
    const worker = new Worker({
      db,
      id: 'trespasser',
      handlers: handlers({
        trespass: async (tx) => {
          await tx
            .insertInto('products')
            .values({ sandbox_id: b, sku: 'PLANTED', name: 'planted', price_minor: 1 })
            .execute();
        },
      }),
    });
    await addJobs(a, 'trespass', 1);
    expect(await worker.runOnce()).toBe(1);

    const [job] = await jobsIn(a, 'trespass');
    expect(job?.status).toBe('queued');
    expect(job?.last_error).toContain('row-level security');
    const planted = await withSandbox(owner, b, (tx) =>
      tx.selectFrom('products').select('sku').where('sku', '=', 'PLANTED').execute(),
    );
    expect(planted).toEqual([]);
  });
});
