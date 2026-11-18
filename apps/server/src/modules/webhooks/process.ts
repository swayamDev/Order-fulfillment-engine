import type { Job, Tx } from '@sethu/db';
import { sql } from 'kysely';
import { PermanentJobError } from '../queue/index.ts';

export interface InboxEventView {
  readonly id: string;
  readonly provider: string;
  readonly providerEventId: string;
  readonly type: string;
  readonly duplicateCount: number;
  readonly payload: Record<string, unknown>;
}

export type WebhookProcessor = (tx: Tx, event: InboxEventView) => Promise<void>;

/**
 * Job handler for webhook.process: hands a stored inbox event to the module
 * that owns its provider, and marks it processed in the same transaction.
 */
export function processWebhook(processors: ReadonlyMap<string, WebhookProcessor>) {
  return async (tx: Tx, job: Job): Promise<void> => {
    const inboxId = job.payload['inboxId'];
    if (typeof inboxId !== 'string') throw new PermanentJobError('webhook.process: no inboxId');

    const row = await tx
      .selectFrom('webhook_inbox')
      .selectAll()
      .where('id', '=', inboxId)
      .forUpdate()
      .executeTakeFirst();
    if (row === undefined) throw new PermanentJobError(`Inbox event ${inboxId} not found`);
    if (row.processed_at !== null) return;

    const processor = processors.get(row.provider);
    if (processor === undefined) {
      throw new PermanentJobError(`No processor for provider ${row.provider}`);
    }
    await processor(tx, {
      id: row.id,
      provider: row.provider,
      providerEventId: row.provider_event_id,
      type: row.event_type,
      duplicateCount: row.duplicate_count,
      payload: row.payload,
    });
    await tx
      .updateTable('webhook_inbox')
      .set({ processed_at: sql<Date>`now()` })
      .where('id', '=', row.id)
      .execute();
  };
}
