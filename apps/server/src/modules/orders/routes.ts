import { IdempotencyKey, PlaceOrderRequest } from '@sethu/contracts';
import type { Db } from '@sethu/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { problem } from '../../http/problem.ts';
import type { SandboxGuard } from '../sandbox/index.ts';
import { getOrder, IdempotencyConflictError, placeOrder, UnknownSkuError } from './service.ts';

const OrderParams = z.object({ id: z.uuid() });

export interface OrderRouteDeps {
  readonly db: Db;
  readonly requireSandbox: SandboxGuard;
  /** Called after an order commits, so the outbox relay can wake. */
  readonly onEventsCommitted: () => void;
}

export function orderRoutes(
  app: FastifyInstance,
  { db, requireSandbox, onEventsCommitted }: OrderRouteDeps,
): void {
  const guard = { preHandler: requireSandbox };

  app.post('/v1/orders', guard, async (request, reply) => {
    const key = IdempotencyKey.safeParse(request.headers['idempotency-key']);
    if (!key.success) {
      return problem(
        reply,
        400,
        'idempotency_key_required',
        key.error.issues[0]?.message ?? 'Send an Idempotency-Key header.',
      );
    }
    const body = PlaceOrderRequest.parse(request.body);
    try {
      const result = await placeOrder(db, request.sandboxId, key.data, body);
      if (result.kind === 'created') {
        onEventsCommitted();
        return await reply.code(201).send(result.order);
      }
      return await reply.code(200).header('idempotent-replayed', 'true').send(result.order);
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        return problem(reply, 422, 'idempotency_key_reused', error.message);
      }
      if (error instanceof UnknownSkuError) {
        return problem(reply, 422, 'unknown_sku', error.message, { skus: error.skus });
      }
      throw error;
    }
  });

  app.get('/v1/orders/:id', guard, async (request, reply) => {
    const params = OrderParams.safeParse(request.params);
    const order = params.success
      ? await getOrder(db, request.sandboxId, params.data.id)
      : undefined;
    if (order === undefined)
      return problem(reply, 404, 'not_found', 'No such order in this sandbox.');
    return order;
  });
}
