# ADR 003: Per-resource sequencing for out-of-order webhooks

Status: accepted, phase 2.

## Context

Providers deliver webhooks over the network, with retries. Events arrive late, twice, or in the wrong order. Even when they arrive in order, two workers can process them in parallel, and the second event can win the race for the order's lock.

Phase 1 relied on the order's state alone. `payment.captured` was applied whenever the order was `payment_pending`, and `payment.authorized` was then ignored as stale. The order ended right, but by accident, and the timeline read differently from run to run.

Dropping events that look early is not acceptable either. If `captured` arrives before `authorized` and is thrown away, nothing ever moves the order to paid.

## Decision

Each provider numbers the events of one resource: a payment (authorized 1, captured 2, refunded 3) or a shipment (in_transit 1, delivered 2). Sethu stores the highest sequence it has applied per resource (`payments.last_seq`, `shipments.last_seq`). Under the order's row lock, then the resource's:

| Arriving sequence | What happens                                                                                                                                                            |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<= last`         | Already applied. Ignored, and recorded on the timeline with the reason. This also covers a repeat sent under a new event id.                                            |
| `last + 1`        | Applied. Then any event already held for `last + 2` is released at once (its job is made due now) instead of waiting out its backoff.                                   |
| `> last + 1`      | **Held.** The handler returns `retryLater`, which commits a single "held" note on the timeline together with the job's new run time, and retries with jittered backoff. |

Holding is bounded twice, and the first bound reached wins:

- **Attempts:** a `webhook.process` job has 8 attempts. When they run out the job goes to the dead-letter queue as `gave up after 8 attempts: out_of_order_unresolved: ...`.
- **Time:** if the event has been held for more than 10 minutes, the next attempt dead-letters it at once, with `out_of_order_unresolved: ... held N min, longer than the 10 min limit`.

The reason always names the sequence the event needed and how far the resource had got, for example: `payment.captured is sequence 2 and needs sequence 1 first (payment has applied up to 0)`.

## Replay

Replaying a held event from the dead-letter queue clears its `held_at`, and the time bound runs from when the event was first held, so a replayed event gets a fresh window. The realistic story: the missing event finally arrives (or is re-sent by the provider), and the operator replays the one that was waiting for it. Both are tested.

## Why handler outcomes, not exceptions

Throwing to retry would roll back the handler's transaction, so the "held" note could never be written. Instead a handler can return `retryLater(reason)` or `deadLetter(reason)`, and the worker writes the job's new status in the handler's own transaction. The note and the deferral commit together, or not at all.

## Consequences

- Webhook application is deterministic: the timeline for a payment reads the same however the deliveries or the workers interleave. The phase 1 test that allowed either order now asserts the exact one.
- A lost event costs a bounded wait, then a clearly labelled dead letter, never a silently stuck order.
- Providers must number events per resource. Real providers expose an equivalent (event creation time plus object version, or an explicit sequence); the simulated ones send `data.sequence`.

## Tests

- `payment-ordering.test.ts` covers events in order; captured first (held, then released the moment authorized applies); a repeat under a new id; a predecessor that never arrives (8 attempts, then dead); held for over 10 minutes (dead at once); and separate sequences per payment. A mutation check confirmed that removing the release step fails the second test.
- `chaos-payments.test.ts` covers the same behaviour driven by the simulated provider's reverse-order and lose-first-event switches.
- `dead-letters.test.ts` replays a dead held event after its predecessor arrives.
