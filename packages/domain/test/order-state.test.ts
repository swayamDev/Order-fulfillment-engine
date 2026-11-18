import { describe, expect, it } from 'vitest';
import {
  EDGES,
  HAPPY_PATH,
  InvalidTransitionError,
  ORDER_STATES,
  assertTransition,
  canTransition,
  isOrderState,
  isTerminal,
  nextStates,
  type OrderState,
  type TransitionContext,
} from '../src/index.ts';

const unpaid: TransitionContext = { paymentCaptured: false };
const captured: TransitionContext = { paymentCaptured: true };

// Written out by hand on purpose: this is the specification the table must match.
const ALLOWED: ReadonlyArray<readonly [OrderState, OrderState]> = [
  ['placed', 'inventory_reserved'],
  ['placed', 'out_of_stock'],
  ['placed', 'cancelled'],
  ['inventory_reserved', 'payment_pending'],
  ['inventory_reserved', 'cancelled'],
  ['payment_pending', 'paid'],
  ['payment_pending', 'payment_failed'],
  ['payment_pending', 'cancelled'],
  ['paid', 'packed'],
  ['paid', 'cancelled'],
  ['packed', 'shipped'],
  ['packed', 'cancelled'],
  ['shipped', 'in_transit'],
  ['shipped', 'shipment_failed'],
  ['in_transit', 'delivered'],
  ['in_transit', 'shipment_failed'],
  ['payment_failed', 'cancelled'],
  ['shipment_failed', 'refunded'],
  ['cancelled', 'refunded'],
];

const isAllowed = (from: OrderState, to: OrderState) =>
  ALLOWED.some(([f, t]) => f === from && t === to);

describe('order state machine', () => {
  describe('every ordered pair of states', () => {
    for (const from of ORDER_STATES) {
      for (const to of ORDER_STATES) {
        const expected = isAllowed(from, to);
        it(`${from} -> ${to} is ${expected ? 'allowed' : 'rejected'}`, () => {
          expect(canTransition(from, to, captured)).toBe(expected);
          if (expected) {
            expect(() => {
              assertTransition(from, to, captured);
            }).not.toThrow();
          } else {
            expect(() => {
              assertTransition(from, to, captured);
            }).toThrow(InvalidTransitionError);
          }
        });
      }
    }
  });

  it('has no self transitions and no duplicate edges', () => {
    const keys = EDGES.map((edge) => `${edge.from}>${edge.to}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(EDGES.filter((edge) => edge.from === edge.to)).toEqual([]);
  });

  it('only refunds a cancelled order when money was captured', () => {
    expect(canTransition('cancelled', 'refunded', unpaid)).toBe(false);
    expect(canTransition('cancelled', 'refunded', captured)).toBe(true);
    expect(isTerminal('cancelled', unpaid)).toBe(true);
    expect(isTerminal('cancelled', captured)).toBe(false);
  });

  it('treats delivered, out_of_stock and refunded as terminal', () => {
    const terminal = ORDER_STATES.filter((state) => isTerminal(state, captured));
    expect(terminal.sort()).toEqual(['delivered', 'out_of_stock', 'refunded']);
  });

  it('walks the happy path one step at a time', () => {
    for (let i = 0; i < HAPPY_PATH.length - 1; i++) {
      const from = HAPPY_PATH[i];
      const to = HAPPY_PATH[i + 1];
      if (from === undefined || to === undefined) throw new Error('unreachable');
      expect(nextStates(from, unpaid)).toContain(to);
    }
  });

  it('cannot skip a step of the happy path', () => {
    expect(canTransition('placed', 'paid', captured)).toBe(false);
    expect(canTransition('shipped', 'delivered', captured)).toBe(false);
  });

  it('cannot cancel once the parcel has left the warehouse', () => {
    for (const state of ['shipped', 'in_transit', 'delivered'] as const) {
      expect(canTransition(state, 'cancelled', captured)).toBe(false);
    }
  });

  it('reaches every state from placed', () => {
    const seen = new Set<OrderState>(['placed']);
    const queue: OrderState[] = ['placed'];
    while (queue.length > 0) {
      const state = queue.shift();
      if (state === undefined) break;
      for (const next of nextStates(state, captured)) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    expect([...seen].sort()).toEqual([...ORDER_STATES].sort());
  });

  it('lets every state reach a terminal state, whatever the payment status', () => {
    for (const ctx of [unpaid, captured]) {
      for (const start of ORDER_STATES) {
        const seen = new Set<OrderState>();
        const stack: OrderState[] = [start];
        let reachesEnd = false;
        while (stack.length > 0 && !reachesEnd) {
          const state = stack.pop();
          if (state === undefined || seen.has(state)) continue;
          seen.add(state);
          if (isTerminal(state, ctx)) reachesEnd = true;
          stack.push(...nextStates(state, ctx));
        }
        expect(reachesEnd, `${start} with paymentCaptured=${ctx.paymentCaptured}`).toBe(true);
      }
    }
  });

  it('describes the error clearly', () => {
    const error = new InvalidTransitionError('delivered', 'cancelled');
    expect(error.message).toBe('Order cannot move from delivered to cancelled');
  });

  it('recognises valid state names', () => {
    expect(isOrderState('paid')).toBe(true);
    expect(isOrderState('lost')).toBe(false);
  });
});
