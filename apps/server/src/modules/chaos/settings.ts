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
  /** The courier's API answers 503 to every booking. */
  readonly courierDown: boolean;
  /** The courier loses the parcel: shipment.failed instead of delivered. */
  readonly courierFailDelivery: boolean;
  /** Kill the worker process that runs this sandbox's next step, before it commits. */
  readonly crashNextStep: boolean;
}

export const NO_CHAOS: ChaosSettings = {
  paymentsDuplicate: false,
  paymentsReverseOrder: false,
  paymentsDropFirst: false,
  paymentsDecline: false,
  paymentsExtraDelayMs: 0,
  courierDown: false,
  courierFailDelivery: false,
  crashNextStep: false,
};

export const ChaosPatch = z
  .object({
    paymentsDuplicate: z.boolean(),
    paymentsReverseOrder: z.boolean(),
    paymentsDropFirst: z.boolean(),
    paymentsDecline: z.boolean(),
    paymentsExtraDelayMs: z.number().int().min(0).max(60_000),
    courierDown: z.boolean(),
    courierFailDelivery: z.boolean(),
    crashNextStep: z.boolean(),
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
    courierDown: row.courier_down,
    courierFailDelivery: row.courier_fail_delivery,
    crashNextStep: row.crash_next_step,
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
      courier_down: next.courierDown,
      courier_fail_delivery: next.courierFailDelivery,
      crash_next_step: next.crashNextStep,
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

/**
 * Takes the sandbox's "crash the next step" switch, if it is on, and turns it
 * off in the same statement. Runs in its own committed transaction before the
 * step starts, so exactly one step crashes and the retry runs normally.
 */
export async function takeCrashSwitch(db: Db, sandboxId: string): Promise<boolean> {
  return withSandbox(db, sandboxId, async (tx) => {
    const row = await tx
      .updateTable('chaos_settings')
      .set({ crash_next_step: false, updated_at: sql<Date>`now()` })
      .where('crash_next_step', '=', true)
      .returning('sandbox_id')
      .executeTakeFirst();
    return row !== undefined;
  });
}
