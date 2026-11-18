import { withSandbox, type Db, type Tx } from '@sethu/db';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import type { SandboxGuard } from '../sandbox/index.ts';

/** How the simulated providers should misbehave for one sandbox. */
export interface ChaosSettings {
  /** Deliver every payment webhook twice. */
  readonly paymentsDuplicate: boolean;
  /** Deliver a payment's webhooks newest first. */
  readonly paymentsReverseOrder: boolean;
  /** Never deliver a payment's first webhook. */
  readonly paymentsDropFirst: boolean;
  /** Decline the payment instead of capturing it. */
  readonly paymentsDecline: boolean;
  /** Extra wait before each payment webhook. */
  readonly paymentsExtraDelayMs: number;
}

export const NO_CHAOS: ChaosSettings = {
  paymentsDuplicate: false,
  paymentsReverseOrder: false,
  paymentsDropFirst: false,
  paymentsDecline: false,
  paymentsExtraDelayMs: 0,
};

export const ChaosPatch = z
  .object({
    paymentsDuplicate: z.boolean(),
    paymentsReverseOrder: z.boolean(),
    paymentsDropFirst: z.boolean(),
    paymentsDecline: z.boolean(),
    paymentsExtraDelayMs: z.number().int().min(0).max(60_000),
  })
  .partial()
  .strict();

/** Reads the sandbox's chaos settings inside an existing sandbox-scoped transaction. */
export async function readChaos(tx: Tx): Promise<ChaosSettings> {
  const row = await tx.selectFrom('chaos_settings').selectAll().executeTakeFirst();
  if (row === undefined) return NO_CHAOS;
  return {
    paymentsDuplicate: row.payments_duplicate,
    paymentsReverseOrder: row.payments_reverse_order,
    paymentsDropFirst: row.payments_drop_first,
    paymentsDecline: row.payments_decline,
    paymentsExtraDelayMs: row.payments_extra_delay_ms,
  };
}

export async function updateChaos(
  db: Db,
  sandboxId: string,
  patch: z.infer<typeof ChaosPatch>,
): Promise<ChaosSettings> {
  return withSandbox(db, sandboxId, async (tx) => {
    const next = { ...(await readChaos(tx)), ...patch };
    const row = {
      payments_duplicate: next.paymentsDuplicate,
      payments_reverse_order: next.paymentsReverseOrder,
      payments_drop_first: next.paymentsDropFirst,
      payments_decline: next.paymentsDecline,
      payments_extra_delay_ms: next.paymentsExtraDelayMs,
      updated_at: sql<Date>`now()`,
    };
    await tx
      .insertInto('chaos_settings')
      .values({ sandbox_id: sandboxId, ...row })
      .onConflict((oc) => oc.column('sandbox_id').doUpdateSet(row))
      .execute();
    return next;
  });
}

export function chaosRoutes(app: FastifyInstance, db: Db, requireSandbox: SandboxGuard): void {
  const guard = { preHandler: requireSandbox };
  app.get('/v1/chaos', guard, (request) =>
    withSandbox(db, request.sandboxId, (tx) => readChaos(tx)),
  );
  app.patch('/v1/chaos', guard, (request) =>
    updateChaos(db, request.sandboxId, ChaosPatch.parse(request.body)),
  );
}
