// A worker process: claims and runs jobs, nothing else. The supervisor in the
// API process forks one or more of these and restarts them when they die.
//
// IPC with the parent:
//   parent -> child  { type: 'wake' }       new work may be due
//   child  -> parent { type: 'committed' }  a job committed (it may have
//                                           written outbox events or jobs)
//
// Chaos "crash the next step": before a job starts, its sandbox's switch is
// taken (in its own committed transaction). If it was on, this process exits
// with code 137 after the handler has run but before its transaction commits,
// exactly like a worker killed mid-step. The lease then expires, the reaper
// requeues the job, and a restarted worker completes it.

import { createDb, type Job } from '@sethu/db';
import { loadConfig } from './config.ts';
import { buildHandlers } from './engine.ts';
import { takeCrashSwitch } from './modules/chaos/index.ts';
import { Worker } from './modules/queue/index.ts';
import { buildProviders } from './wiring.ts';

export const CRASH_EXIT_CODE = 137;

const config = loadConfig();
const db = createDb(config.DATABASE_URL, config.WORKER_CONCURRENCY + 2);
const handlers = buildHandlers(buildProviders(config));
const send = (message: { type: string }) => process.send?.(message);

let crashOnCommit: string | undefined;

const workers = Array.from(
  { length: config.WORKER_CONCURRENCY },
  (_, i) =>
    new Worker({
      db,
      id: `worker-${process.pid}-${i}`,
      handlers,
      leaseSeconds: config.WORKER_LEASE_SECONDS,
      beforeJob: async (job: Job) => {
        if (await takeCrashSwitch(db, job.sandbox_id)) crashOnCommit = job.id;
      },
      beforeCommit: (job: Job) => {
        if (crashOnCommit === job.id) {
          console.error(
            `chaos: worker ${String(process.pid)} crashing mid-step in ${job.queue} (job ${job.id})`,
          );
          process.exit(CRASH_EXIT_CODE);
        }
        return Promise.resolve();
      },
      onCommitted: () => {
        send({ type: 'committed' });
      },
      onLoopError: (error) => {
        console.error('worker loop failed; retrying', error);
      },
    }),
);

const wakeAll = () => {
  for (const worker of workers) worker.waker.notify();
};

process.on('message', (message: { type?: string }) => {
  if (message.type === 'wake') wakeAll();
});

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await Promise.all(workers.map((w) => w.stop()));
  await db.destroy();
  process.exit(0);
}
process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());
// If the parent goes away, so do we.
process.once('disconnect', () => void shutdown());

for (const worker of workers) worker.start();
send({ type: 'ready' });
