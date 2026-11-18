import type { Tx } from '@sethu/db';
import { sql } from 'kysely';
import { z } from 'zod';
import { appendOrderEvent, lockOrder, transitionOrder } from '../orders/index.ts';
import { PermanentJobError, type JobOutcome } from '../queue/index.ts';
import { checkSequence, releaseNext, type InboxEventView } from '../webhooks/index.ts';

const ShipmentData = z.object({
  shipment_id: z.string(),
  order_id: z.uuid(),
  sequence: z.number().int().min(1),
});

/**
 * Applies a courier tracking webhook in the shipment's own sequence, under the
 * order's row lock and then the shipment's, exactly like payment webhooks.
 */
export async function applyCourierWebhook(
  tx: Tx,
  event: InboxEventView,
): Promise<JobOutcome | undefined> {
  const parsed = ShipmentData.safeParse(event.payload['data']);
  if (!parsed.success) {
    throw new PermanentJobError(`Courier webhook ${event.providerEventId} is missing its data`);
  }
  const data = parsed.data;
  const order = await lockOrder(tx, data.order_id);
  if (order === undefined) {
    throw new PermanentJobError(`Courier webhook ${event.providerEventId}: order not found`);
  }
  const shipment = await tx
    .selectFrom('shipments')
    .selectAll()
    .where('shipment_id', '=', data.shipment_id)
    .forUpdate()
    .executeTakeFirst();
  if (shipment === undefined) {
    throw new PermanentJobError(`Courier webhook ${event.providerEventId}: unknown shipment`);
  }

  const note = {
    provider: event.provider,
    type: event.type,
    eventId: event.providerEventId,
    shipmentId: data.shipment_id,
    sequence: data.sequence,
    duplicatesSoFar: event.duplicateCount,
    simulated: event.payload['simulated'] === true,
  };
  const verdict = await checkSequence({
    tx,
    order,
    event,
    note,
    subject: 'shipment',
    sequence: data.sequence,
    lastApplied: shipment.last_seq,
  });
  if (verdict.kind === 'done') return undefined;
  if (verdict.kind === 'defer') return verdict.outcome;

  const outcome = decide(order.state, event.type);
  await appendOrderEvent(tx, order, 'webhook', {
    ...note,
    outcome: outcome.kind,
    ...(outcome.kind === 'ignored' ? { reason: outcome.reason } : {}),
  });
  await tx
    .updateTable('shipments')
    .set({
      last_seq: data.sequence,
      updated_at: sql<Date>`now()`,
      ...(outcome.kind === 'apply' ? { status: outcome.shipmentStatus } : {}),
    })
    .where('shipment_id', '=', data.shipment_id)
    .execute();
  if (outcome.kind === 'apply') {
    await transitionOrder(tx, order, outcome.to, {
      cause: { by: 'webhook', eventId: event.providerEventId, type: event.type },
    });
  }
  await releaseNext(tx, event.provider, 'shipment_id', data.shipment_id, data.sequence + 1);
  return undefined;
}

type Outcome =
  | {
      kind: 'apply';
      to: 'in_transit' | 'delivered' | 'shipment_failed';
      shipmentStatus: 'in_transit' | 'delivered' | 'failed';
    }
  | { kind: 'ignored'; reason: string };

function decide(state: string, type: string): Outcome {
  switch (type) {
    case 'shipment.in_transit':
      return state === 'shipped'
        ? { kind: 'apply', to: 'in_transit', shipmentStatus: 'in_transit' }
        : { kind: 'ignored', reason: `order is ${state}, not shipped` };
    case 'shipment.delivered':
      return state === 'in_transit'
        ? { kind: 'apply', to: 'delivered', shipmentStatus: 'delivered' }
        : { kind: 'ignored', reason: `order is ${state}, not in_transit` };
    case 'shipment.failed':
      return state === 'shipped' || state === 'in_transit'
        ? { kind: 'apply', to: 'shipment_failed', shipmentStatus: 'failed' }
        : { kind: 'ignored', reason: `order is ${state}, not on its way` };
    default:
      return { kind: 'ignored', reason: `unknown event type ${type}` };
  }
}
