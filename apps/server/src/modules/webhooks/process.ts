import type { Job, Tx } from '@sethu/db';
import { sql } from 'kysely';
import { PermanentJobError, type JobOutcome } from '../queue/index.ts';

export interface InboxEventView {
  readonly id: string;
  readonly provider: string;
  readonly providerEventId: string;
  readonly type: string;
  readonly duplicateCount: number;
  readonly payload: Record<string, unknown>;
  readonly receivedAt: Date;
  /** When this event was first held waiting for an earlier one, if ever. */
  readonly heldAt: Date | null;
}

/**
 * Applies one inbox event. Returning nothing means it was handled (applied or
 * deliberately ignored); returning an outcome defers or dead-letters it.
 */
// eslint-disable-next-line @typescript-eslint/no-invalid-void-type
export type WebhookProcessor = (tx: Tx, event: InboxEventView) => Promise<void | JobOutcome>;

/**
 * Job handler for webhook.process: hands a stored inbox event to the module
 * that owns its provider. The event is marked processed in the same
 * transaction, unless the processor deferred it.
 */
export function processWebhook(processors: ReadonlyMap<string, WebhookProcessor>) {
  return async (tx: Tx, job: Job): Promise<JobOutcome | undefined> => {
    const inboxId = job.payload['inboxId'];
    if (typeof inboxId !== 'string') throw new PermanentJobError('webhook.process: no inboxId');

    const row = await tx
      .selectFrom('webhook_inbox')
      .selectAll()
      .where('id', '=', inboxId)
      .forUpdate()
      .executeTakeFirst();
    if (row === undefined) throw new PermanentJobError(`Inbox event ${inboxId} not found`);
    if (row.processed_at !== null) return undefined;

    const processor = processors.get(row.provider);
    if (processor === undefined) {
      throw new PermanentJobError(`No processor for provider ${row.provider}`);
    }
    const outcome = await processor(tx, {
      id: row.id,
      provider: row.provider,
      providerEventId: row.provider_event_id,
      type: row.event_type,
      duplicateCount: row.duplicate_count,
      payload: row.payload,
      receivedAt: row.received_at,
      heldAt: row.held_at,
    });
    if (outcome !== undefined) return outcome;

    await tx
      .updateTable('webhook_inbox')
      .set({ processed_at: sql<Date>`now()` })
      .where('id', '=', row.id)
      .execute();
    return undefined;
  };
}
