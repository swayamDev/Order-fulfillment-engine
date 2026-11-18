// SIMULATED courier. Not a real carrier: it stands in for one so that
// shipping (an idempotent booking call, then signed tracking webhooks) is
// exercised over real HTTP, and so the chaos panel can take it down or make
// it lose parcels. Everything it sends is labelled simulated.

import { randomUUID } from 'node:crypto';
import { withSandbox, type Db } from '@sethu/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { problem } from '../../http/problem.ts';
import { readChaos } from '../chaos/index.ts';
import { enqueue } from '../queue/index.ts';
import { deliverSignedWebhook } from '../sim-shared/index.ts';

export const SIM_COURIER = 'sim-courier';
export const DELIVER_SIM_COURIER_WEBHOOK = 'sim-courier.deliver';

export interface SimCourierConfig {
  readonly apiKey: string;
  readonly signingSecret: string;
  readonly webhookUrl: () => string;
  /** Gap between successive tracking webhooks for one shipment. */
  readonly delayMs: number;
}

const BookShipment = z.object({ sandbox_id: z.uuid(), order_id: z.uuid() });

export function simCourierRoutes(
  app: FastifyInstance,
  db: Db,
  config: SimCourierConfig,
  onJobsQueued: () => void,
): void {
  app.post('/sim/courier/v1/shipments', async (request, reply) => {
    reply.header('x-sethu-simulated', 'true');
    if (request.headers.authorization !== `Bearer ${config.apiKey}`) {
      return problem(reply, 401, 'unauthorized', 'Simulated courier: bad API key.');
    }
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 8) {
      return problem(reply, 400, 'idempotency_key_required', 'Simulated courier needs a key.');
    }
    const body = BookShipment.parse(request.body);

    const result = await withSandbox(db, body.sandbox_id, async (tx) => {
      const chaos = await readChaos(tx);
      if (chaos.courierDown) return { kind: 'down' as const };

      const created = await tx
        .insertInto('sim_shipments')
        .values({
          id: `shp_sim_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
          sandbox_id: body.sandbox_id,
          order_id: body.order_id,
          idempotency_key: key,
          status: chaos.courierFailDelivery ? 'failed' : 'delivered',
        })
        .onConflict((oc) => oc.columns(['sandbox_id', 'idempotency_key']).doNothing())
        .returningAll()
        .executeTakeFirst();
      if (created === undefined) {
        const existing = await tx
          .selectFrom('sim_shipments')
          .select('id')
          .where('idempotency_key', '=', key)
          .executeTakeFirstOrThrow();
        return { kind: 'replayed' as const, id: existing.id };
      }

      const types = [
        'shipment.in_transit',
        chaos.courierFailDelivery ? 'shipment.failed' : 'shipment.delivered',
      ];
      for (const [i, type] of types.entries()) {
        const envelope = {
          id: `evt_simc_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
          type,
          created: Math.floor(Date.now() / 1000),
          sandbox_id: body.sandbox_id,
          simulated: true as const,
          data: { shipment_id: created.id, order_id: body.order_id, sequence: i + 1 },
        };
        await enqueue(tx, {
          sandboxId: body.sandbox_id,
          queue: DELIVER_SIM_COURIER_WEBHOOK,
          payload: { envelope },
          dedupeKey: `simc-deliver:${envelope.id}`,
          delayMs: config.delayMs * (i + 1) + i * 2,
          maxAttempts: 8,
        });
      }
      return { kind: 'created' as const, id: created.id };
    });

    if (result.kind === 'down') {
      return problem(reply, 503, 'courier_unavailable', 'Simulated courier is down (chaos).');
    }
    if (result.kind === 'created') onJobsQueued();
    return reply
      .code(result.kind === 'created' ? 201 : 200)
      .send({ id: result.id, status: 'booked', simulated: true });
  });
}

/** Job handler: deliver one of the courier's signed tracking webhooks. */
export function deliverSimCourierWebhook(config: SimCourierConfig) {
  return deliverSignedWebhook(config);
}
