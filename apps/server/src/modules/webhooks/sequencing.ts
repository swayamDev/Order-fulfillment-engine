// Strict per-resource ordering for provider webhooks (one payment, one
// shipment). Providers number each resource's events 1, 2, 3...; Sethu keeps
// the highest sequence it has applied and, under the resource's row lock:
//
//   sequence <= last      already applied: ignored, recorded on the timeline
//   sequence == last + 1  applied by the caller, which then calls releaseNext
//   sequence >  last + 1  held: deferred with backoff and noted once on the
//                         timeline, then dead-lettered as out_of_order_unresolved
//                         after its attempts run out or MAX_HOLD_MS passes

import type { Order, Tx } from '@sethu/db';
import { sql } from 'kysely';
import { appendOrderEvent } from '../orders/index.ts';
import { deadLetter, retryLater, type JobOutcome } from '../queue/index.ts';
import type { InboxEventView } from './process.ts';

/** The longest an event may wait for an earlier one before it is dead-lettered. */
export const MAX_HOLD_MS = 10 * 60_000;

export interface SequenceInput {
  readonly tx: Tx;
  readonly order: Order;
  readonly event: InboxEventView;
  /** Fields recorded with every timeline note about this event. */
  readonly note: Record<string, unknown>;
  /** "payment" or "shipment", used in messages. */
  readonly subject: string;
  readonly sequence: number;
  readonly lastApplied: number;
}

export type SequenceVerdict =
  | { readonly kind: 'apply' }
  | { readonly kind: 'done' }
  | { readonly kind: 'defer'; readonly outcome: JobOutcome };

export async function checkSequence(input: SequenceInput): Promise<SequenceVerdict> {
  const { tx, order, event, note, subject, sequence, lastApplied } = input;
  const expected = lastApplied + 1;

  if (sequence === expected) return { kind: 'apply' };

  if (sequence < expected) {
    await appendOrderEvent(tx, order, 'webhook', {
      ...note,
      outcome: 'ignored',
      reason: `sequence ${sequence} was already applied (${subject} is at ${lastApplied})`,
    });
    return { kind: 'done' };
  }

  const heldMs = Date.now() - event.receivedAt.getTime();
  const waiting = `${event.type} is sequence ${sequence} and needs sequence ${expected} first (${subject} has applied up to ${lastApplied})`;
  if (heldMs > MAX_HOLD_MS) {
    const reason = `out_of_order_unresolved: ${waiting}; held ${Math.round(heldMs / 60_000)} min, longer than the ${MAX_HOLD_MS / 60_000} min limit`;
    await appendOrderEvent(tx, order, 'webhook', { ...note, outcome: 'dead_lettered', reason });
    return { kind: 'defer', outcome: deadLetter(reason) };
  }
  if (event.heldAt === null) {
    await tx
      .updateTable('webhook_inbox')
      .set({ held_at: sql<Date>`now()` })
      .where('id', '=', event.id)
      .execute();
    await appendOrderEvent(tx, order, 'webhook', {
      ...note,
      outcome: 'held',
      reason: `waiting for sequence ${expected}`,
    });
  }
  return { kind: 'defer', outcome: retryLater(`out_of_order_unresolved: ${waiting}`) };
}

/**
 * After applying `sequence - 1`, wakes the event held for `sequence` (if any)
 * now instead of after its backoff.
 */
export async function releaseNext(
  tx: Tx,
  provider: string,
  idField: string,
  id: string,
  sequence: number,
): Promise<void> {
  await tx
    .updateTable('jobs')
    .set({ run_at: sql<Date>`now()`, updated_at: sql<Date>`now()` })
    .where('status', '=', 'queued')
    .where(
      'dedupe_key',
      'in',
      tx
        .selectFrom('webhook_inbox')
        .select(sql<string>`'webhook:' || id`.as('key'))
        .where('provider', '=', provider)
        .where('held_at', 'is not', null)
        .where('processed_at', 'is', null)
        .where(sql<string>`payload->'data'->>${idField}`, '=', id)
        .where(sql<string>`payload->'data'->>'sequence'`, '=', String(sequence)),
    )
    .execute();
}
