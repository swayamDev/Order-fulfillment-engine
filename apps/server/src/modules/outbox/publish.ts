import type { Tx } from '@sethu/db';

export interface DomainEvent {
  readonly sandboxId: string;
  readonly topic: string;
  readonly aggregateId: string;
  readonly payload: Record<string, unknown>;
}

/** What a consumer job receives: the event plus the outbox row's id. */
export interface OutboxMessage {
  readonly messageId: string;
  readonly topic: string;
  readonly aggregateId: string;
  readonly payload: Record<string, unknown>;
}

/**
 * Records an event in the caller's transaction. The event exists if and only
 * if the state change that caused it commits: no dual write, no lost events.
 */
export async function publish(tx: Tx, event: DomainEvent): Promise<string> {
  const row = await tx
    .insertInto('outbox')
    .values({
      sandbox_id: event.sandboxId,
      topic: event.topic,
      aggregate_id: event.aggregateId,
      payload: event.payload,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

/**
 * Records that `consumer` has handled `messageId`, in the same transaction as
 * the consumer's effects. Returns false if it was handled before, in which case
 * the consumer must do nothing: that makes redelivery harmless.
 */
export async function markProcessed(
  tx: Tx,
  consumer: string,
  messageId: string,
  sandboxId: string,
): Promise<boolean> {
  const row = await tx
    .insertInto('processed_messages')
    .values({ consumer, message_id: messageId, sandbox_id: sandboxId })
    .onConflict((oc) => oc.columns(['consumer', 'message_id']).doNothing())
    .returning('message_id')
    .executeTakeFirst();
  return row !== undefined;
}
