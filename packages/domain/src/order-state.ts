// The order lifecycle as data. The engine enforces it, and the console draws
// the bridge-span diagram from the same table, so the two cannot drift apart.

export const ORDER_STATES = [
  'placed',
  'inventory_reserved',
  'payment_pending',
  'paid',
  'packed',
  'shipped',
  'in_transit',
  'delivered',
  'out_of_stock',
  'payment_failed',
  'shipment_failed',
  'cancelled',
  'refunded',
] as const;

export type OrderState = (typeof ORDER_STATES)[number];

/** The happy path, left to right: the deck of the span. */
export const HAPPY_PATH = [
  'placed',
  'inventory_reserved',
  'payment_pending',
  'paid',
  'packed',
  'shipped',
  'in_transit',
  'delivered',
] as const satisfies readonly OrderState[];

/** Facts about an order that some transitions depend on. */
export interface TransitionContext {
  /** True once money has actually been taken (the payment was captured). */
  readonly paymentCaptured: boolean;
}

export type EdgeKind = 'forward' | 'failure' | 'cancel' | 'compensation';

export interface Edge {
  readonly from: OrderState;
  readonly to: OrderState;
  readonly kind: EdgeKind;
  /** Name of the guard, shown in the console next to a guarded edge. */
  readonly guard?: 'payment_captured';
}

export const EDGES: readonly Edge[] = [
  { from: 'placed', to: 'inventory_reserved', kind: 'forward' },
  { from: 'inventory_reserved', to: 'payment_pending', kind: 'forward' },
  { from: 'payment_pending', to: 'paid', kind: 'forward' },
  { from: 'paid', to: 'packed', kind: 'forward' },
  { from: 'packed', to: 'shipped', kind: 'forward' },
  { from: 'shipped', to: 'in_transit', kind: 'forward' },
  { from: 'in_transit', to: 'delivered', kind: 'forward' },

  { from: 'placed', to: 'out_of_stock', kind: 'failure' },
  { from: 'payment_pending', to: 'payment_failed', kind: 'failure' },
  { from: 'shipped', to: 'shipment_failed', kind: 'failure' },
  { from: 'in_transit', to: 'shipment_failed', kind: 'failure' },

  { from: 'placed', to: 'cancelled', kind: 'cancel' },
  { from: 'inventory_reserved', to: 'cancelled', kind: 'cancel' },
  { from: 'payment_pending', to: 'cancelled', kind: 'cancel' },
  { from: 'paid', to: 'cancelled', kind: 'cancel' },
  { from: 'packed', to: 'cancelled', kind: 'cancel' },

  { from: 'payment_failed', to: 'cancelled', kind: 'compensation' },
  { from: 'shipment_failed', to: 'refunded', kind: 'compensation' },
  { from: 'cancelled', to: 'refunded', kind: 'compensation', guard: 'payment_captured' },
];

const GUARDS: Record<NonNullable<Edge['guard']>, (ctx: TransitionContext) => boolean> = {
  payment_captured: (ctx) => ctx.paymentCaptured,
};

export function findEdge(from: OrderState, to: OrderState): Edge | undefined {
  return EDGES.find((edge) => edge.from === from && edge.to === to);
}

export function canTransition(from: OrderState, to: OrderState, ctx: TransitionContext): boolean {
  const edge = findEdge(from, to);
  if (edge === undefined) return false;
  return edge.guard === undefined || GUARDS[edge.guard](ctx);
}

export function nextStates(from: OrderState, ctx: TransitionContext): OrderState[] {
  return EDGES.filter((edge) => edge.from === from && canTransition(from, edge.to, ctx)).map(
    (edge) => edge.to,
  );
}

export function isTerminal(state: OrderState, ctx: TransitionContext): boolean {
  return nextStates(state, ctx).length === 0;
}

export class InvalidTransitionError extends Error {
  readonly from: OrderState;
  readonly to: OrderState;

  constructor(from: OrderState, to: OrderState) {
    super(`Order cannot move from ${from} to ${to}`);
    this.name = 'InvalidTransitionError';
    this.from = from;
    this.to = to;
  }
}

export function assertTransition(from: OrderState, to: OrderState, ctx: TransitionContext): void {
  if (!canTransition(from, to, ctx)) throw new InvalidTransitionError(from, to);
}

export function isOrderState(value: string): value is OrderState {
  return (ORDER_STATES as readonly string[]).includes(value);
}
