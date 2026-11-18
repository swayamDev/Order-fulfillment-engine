import { setSandbox, type Db, type OutboxRow } from '@sethu/db';
import { sql } from 'kysely';
import { enqueue, Waker } from '../queue/index.ts';
import type { OutboxMessage } from './publish.ts';

/** Which consumer queues receive each topic. */
export type Subscriptions = ReadonlyMap<string, readonly string[]>;

export interface RelayOptions {
  readonly db: Db;
  readonly subscriptions: Subscriptions;
  readonly batchSize?: number;
  readonly maxIdleMs?: number;
  readonly waker?: Waker;
  /** Called after a batch commits, so workers (and later the live stream) can wake. */
  readonly onPublished?: (events: readonly OutboxRow[]) => void;
}

/**
 * Moves committed events from the outbox to consumer jobs. Each event becomes
 * one job per subscribed consumer, keyed "<event id>:<consumer>", so running
 * the relay twice over the same event (after a crash, or concurrently) cannot
 * create a second job.
 */
export class OutboxRelay {
  readonly waker: Waker;
  private readonly db: Db;
  private readonly subscriptions: Subscriptions;
  private readonly batchSize: number;
  private readonly maxIdleMs: number;
  private readonly onPublished: (events: readonly OutboxRow[]) => void;
  private running: Promise<void> | undefined;
  private stopped = false;

  constructor(options: RelayOptions) {
    this.db = options.db;
    this.subscriptions = options.subscriptions;
    this.batchSize = options.batchSize ?? 100;
    this.maxIdleMs = options.maxIdleMs ?? 30 * 60_000;
    this.waker = options.waker ?? new Waker();
    this.onPublished = options.onPublished ?? (() => undefined);
  }

  /** Relays one batch. Returns how many events it published. */
  async runOnce(): Promise<number> {
    const events = await this.db.transaction().execute(async (tx) => {
      const { rows } = await sql<OutboxRow>`
        SELECT * FROM claim_outbox(${this.batchSize})
      `.execute(tx);
      for (const event of rows) {
        await setSandbox(tx, event.sandbox_id);
        const message: OutboxMessage = {
          messageId: event.id,
          topic: event.topic,
          aggregateId: event.aggregate_id,
          payload: event.payload,
        };
        for (const consumer of this.subscriptions.get(event.topic) ?? []) {
          await enqueue(tx, {
            sandboxId: event.sandbox_id,
            queue: consumer,
            payload: { ...message },
            dedupeKey: `${event.id}:${consumer}`,
          });
        }
        await tx
          .updateTable('outbox')
          .set({ published_at: sql<Date>`now()` })
          .where('id', '=', event.id)
          .execute();
      }
      return rows;
    });
    if (events.length > 0) this.onPublished(events);
    return events.length;
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
      if ((await this.runOnce()) > 0) continue;
      await this.waker.sleep(this.maxIdleMs);
    }
  }
}
