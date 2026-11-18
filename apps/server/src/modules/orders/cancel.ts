import { canTransition } from '@sethu/domain';
import { withSandbox, type Db } from '@sethu/db';
import { lockOrder, transitionOrder } from './lifecycle.ts';

export type CancelResult =
  | { readonly kind: 'cancelled'; readonly version: number }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'stale'; readonly currentVersion: number }
  | { readonly kind: 'not_allowed'; readonly state: string };

/**
 * Cancels an order on behalf of an operator. The caller states which version
 * it saw (If-Match); if anything changed the order since, the cancel is
 * refused rather than applied to a state the operator never looked at.
 * Stock release and any refund follow as compensations of order.cancelled.
 */
export async function cancelOrder(
  db: Db,
  sandboxId: string,
  orderId: string,
  expectedVersion: number,
): Promise<CancelResult> {
  return withSandbox(db, sandboxId, async (tx) => {
    const order = await lockOrder(tx, orderId);
    if (order === undefined) return { kind: 'not_found' };
    if (order.version !== expectedVersion) return { kind: 'stale', currentVersion: order.version };
    if (!canTransition(order.state, 'cancelled', { paymentCaptured: order.payment_captured })) {
      return { kind: 'not_allowed', state: order.state };
    }
    const updated = await transitionOrder(tx, order, 'cancelled', {
      cause: { by: 'api', reason: 'cancelled by an operator' },
    });
    return { kind: 'cancelled', version: updated.version };
  });
}
