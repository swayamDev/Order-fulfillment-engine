import { fork, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';

export interface WorkerExit {
  readonly slot: number;
  readonly pid: number | undefined;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface SupervisorOptions {
  /** How many worker processes to keep running. */
  readonly processes: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly entry?: string;
}

/**
 * Keeps N worker processes alive. A worker that exits (crashed, killed, out
 * of memory) is restarted after a short backoff that doubles while it keeps
 * dying quickly, and resets once it has stayed up for a while.
 *
 * Events: 'message' (message, slot), 'exit' (WorkerExit), 'spawn' (slot, pid).
 */
export class Supervisor extends EventEmitter {
  private readonly options: SupervisorOptions;
  private readonly entry: string;
  private readonly children = new Map<number, ChildProcess>();
  private readonly restartDelay = new Map<number, number>();
  private stopping = false;

  constructor(options: SupervisorOptions) {
    super();
    this.options = options;
    this.entry = options.entry ?? fileURLToPath(new URL('./worker-process.ts', import.meta.url));
  }

  start(): void {
    this.stopping = false;
    for (let slot = 0; slot < this.options.processes; slot++) this.spawn(slot);
  }

  /** Sends a message to every live worker process. */
  broadcast(message: { type: string }): void {
    for (const child of this.children.values()) {
      if (child.connected) child.send(message);
    }
  }

  pids(): number[] {
    return [...this.children.values()].flatMap((c) => (c.pid === undefined ? [] : [c.pid]));
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await Promise.all(
      [...this.children.values()].map(
        (child) =>
          new Promise<void>((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) {
              resolve();
              return;
            }
            child.once('exit', () => {
              resolve();
            });
            child.kill('SIGTERM');
          }),
      ),
    );
    this.children.clear();
  }

  private spawn(slot: number): void {
    const startedAt = Date.now();
    const child = fork(this.entry, [], {
      env: this.options.env ?? process.env,
      execArgv: [],
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    this.children.set(slot, child);
    this.emit('spawn', slot, child.pid);

    child.on('message', (message) => {
      this.emit('message', message, slot);
    });
    child.once('exit', (code, signal) => {
      this.children.delete(slot);
      this.emit('exit', { slot, pid: child.pid, code, signal } satisfies WorkerExit);
      if (this.stopping) return;
      const stayedUpMs = Date.now() - startedAt;
      const previous = this.restartDelay.get(slot) ?? 100;
      const delay = stayedUpMs > 30_000 ? 200 : Math.min(previous * 2, 10_000);
      this.restartDelay.set(slot, delay);
      setTimeout(() => {
        if (!this.stopping) this.spawn(slot);
      }, delay);
    });
  }
}
