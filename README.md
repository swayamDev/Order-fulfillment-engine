# Sethu

An event-driven order fulfillment engine for a fictional online store, with an internal operations console.

Sethu takes an order from placement to delivery through a chain of small, independent steps. Every step is a database transaction that can crash, be retried or be delivered twice without double-reserving stock, double-charging or double-shipping. The payment provider and the courier are simulated, and labelled so everywhere, so that failures can be produced on demand and the recovery watched.

**Status: phase 2 of 5.** The engine works end to end without a UI: placed, inventory reserved, payment pending, paid, packed, shipped, in transit, delivered, plus every failure path and its compensation, a dead-letter queue with replay, and chaos switches for each failure scenario. The console, the public demo and deployment come in later phases.

## How an order moves

```
 API request                         worker process (job handler)          simulated providers
 ───────────                         ────────────────────────────          ───────────────────
 POST /v1/orders
  └ one transaction: order + items + timeline + outbox event order.placed
                │
          outbox relay ──► inventory.reserve: lock order, lock stock rows (SKU order),
                │                             reserve all lines or none
                │
          outbox relay ──► payments.request:  create intent (idempotency key) ──► payment provider
                │                             order -> payment_pending                │
                │                                                                     │ signed
 POST /v1/webhooks/sim-payments ◄──────────────────────────────────────────────────────┘ webhooks
  └ verify signature, store once ──► webhook.process: apply in per-payment sequence
                │                                       order -> paid
          outbox relay ──► fulfillment.pack:  stock leaves the shelf, order -> packed
                │
          outbox relay ──► fulfillment.ship:  book courier (idempotency key) ──────► courier
                │                             order -> shipped                         │
 POST /v1/webhooks/sim-courier ◄────────────────────────────────────────────────────────┘
  └ verify, store once ──► webhook.process: in_transit, delivered (per-shipment sequence)
```

Failure paths and their compensations:

| Failure                                        | Compensation                                                                 |
| ---------------------------------------------- | ---------------------------------------------------------------------------- |
| Out of stock                                   | Nothing was reserved; the order ends `out_of_stock`                          |
| Payment declined                               | Release the reservation, then `cancelled`                                    |
| Cancelled before payment                       | Release the reservation                                                      |
| Cancelled after payment (or after packing)     | Release or restock, then refund; the refund webhook moves it to `refunded`   |
| Payment captured after the order was cancelled | Refund automatically                                                         |
| Courier down                                   | Retry with backoff; if it never recovers, the dead-letter queue, then replay |
| Parcel lost (`shipment.failed`)                | Restock, then refund, then `refunded`                                        |

## Guarantees, and the tests that prove them

| Guarantee                                              | How                                                                                                              | Test                                                       |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| No event is lost or invented                           | Transactional outbox: events commit with the state change                                                        | `outbox.test.ts`                                           |
| A job runs to completion once                          | `FOR UPDATE SKIP LOCKED` claims, leases, a reaper for crashed workers, a row lock that fences out stale workers  | `queue.test.ts`: 8 workers, 1,000 jobs, each once          |
| A worker can die mid-step                              | The step's transaction never commits; the lease expires and a restarted worker redoes it                         | `worker-crash.test.ts`: a real process exits with code 137 |
| Redelivery is harmless                                 | Consumers record `(consumer, message id)` in the same transaction as their effects                               | `outbox.test.ts`, `inventory.test.ts`                      |
| Webhooks apply in order, whatever order they arrive in | Per-resource sequence numbers; early events are held, then released; held too long ends in the dead-letter queue | `payment-ordering.test.ts`, `chaos-payments.test.ts`       |
| No oversell                                            | Stock rows locked in SKU order, all-or-nothing reservation, `CHECK (available >= 0)`                             | `inventory.test.ts`: 10 orders race for 2 kettles          |
| A double click places one order                        | `Idempotency-Key`, unique per sandbox, request hash compared on replay                                           | `orders.test.ts`: 10 identical requests race               |
| Retried provider calls do not repeat                   | Charges, refunds and bookings carry idempotency keys derived from the order                                      | `payments.test.ts`, `compensation.test.ts`                 |
| An operator cannot act on a stale view                 | Cancel requires `If-Match` with the order version; 409 if it moved on                                            | `compensation.test.ts`                                     |
| Forged or replayed webhooks are rejected               | HMAC-SHA256 over timestamp and raw body, 5 minute window, unique event id, secret rotation                       | `webhooks.test.ts`, `webhook-signature.test.ts`            |
| Only allowed transitions happen                        | The state machine is a table; every one of the 169 state pairs is tested                                         | `order-state.test.ts`                                      |
| One visitor cannot see another's data                  | Forced row level security, a non-owner app role, and an HMAC-signed session cookie                               | `rls.int.test.ts`, `sandbox.test.ts`, `queue.test.ts`      |
| Retries do not stampede                                | Exponential backoff with full jitter, then a dead-letter status and replay with an audit trail                   | `backoff.test.ts`, `dead-letters.test.ts`                  |

## Chaos switches

`PATCH /v1/chaos` changes one sandbox's switches. Each switch has an integration test that makes the failure happen and checks the recovery.

| Switch                 | What the simulated provider does                                           | Test                                             |
| ---------------------- | -------------------------------------------------------------------------- | ------------------------------------------------ |
| `paymentsDuplicate`    | Sends every payment webhook twice                                          | `chaos-payments.test.ts`                         |
| `paymentsReverseOrder` | Sends a payment's webhooks newest first                                    | `chaos-payments.test.ts`                         |
| `paymentsDropFirst`    | Loses a payment's first webhook                                            | `chaos-payments.test.ts`, `dead-letters.test.ts` |
| `paymentsExtraDelayMs` | Waits longer before each webhook                                           | `chaos-payments.test.ts`                         |
| `paymentsDecline`      | Declines the payment                                                       | `chaos-payments.test.ts`, `compensation.test.ts` |
| `courierDown`          | The courier's API answers 503                                              | `shipping.test.ts`, `dead-letters.test.ts`       |
| `courierFailDelivery`  | The courier loses the parcel                                               | `shipping.test.ts`                               |
| `crashNextStep`        | The worker process running the sandbox's next step exits before it commits | `worker-crash.test.ts`                           |

## Running it locally

Requires Node 24 or later, pnpm and Docker.

```sh
pnpm install
cp .env.example .env
pnpm db:up          # Postgres 17 on port 54329
pnpm db:roles       # creates sethu_app and sethu_system
pnpm db:migrate     # runs as the owner role
pnpm dev            # API, relay and 2 supervised worker processes on http://localhost:4000
```

Try an order (the console is not built yet, so this uses curl and a cookie jar):

```sh
H=(-H 'origin: http://localhost:3000' -H 'content-type: application/json')
curl -c jar -b jar -X POST localhost:4000/v1/sandboxes "${H[@]}" -d '{}'

# Optional: make things go wrong.
curl -b jar -X PATCH localhost:4000/v1/chaos "${H[@]}" \
  -d '{"paymentsReverseOrder":true,"crashNextStep":true}'

curl -c jar -b jar -X POST localhost:4000/v1/orders "${H[@]}" \
  -H 'idempotency-key: my-first-order' \
  -d '{"items":[{"sku":"MUG-STONE-01","quantity":2}]}'

# Watch it move (about 10 seconds, or 25 with a crashed worker):
curl -b jar localhost:4000/v1/orders/<order id>
curl -b jar localhost:4000/v1/dead-letters
```

## Tests

```sh
pnpm test               # unit tests
pnpm test:integration   # against the real Postgres from docker compose
pnpm lint && pnpm typecheck
pnpm check:repo         # no em dashes, no AI tool configuration files
```

CI runs all of the above on every push, with Postgres 17 as a service container.

## Layout

```
apps/server/src/
  main.ts            API process: HTTP API, simulated providers, outbox relay, supervisor
  worker-process.ts  a supervised worker process
  supervisor.ts      forks and restarts worker processes
  engine.ts          which consumer handles which event
  wiring.ts          provider clients and simulators from configuration
  modules/
    sandbox/         visitor sandboxes and the signed session cookie
    orders/          placing and cancelling orders, the timeline, state transitions
    inventory/       reserving, releasing, consuming and restocking
    payments/        payment requests, refunds, payment webhooks
    shipping/        packing, courier booking, courier webhooks
    compensation/    what to undo when an order fails or is cancelled
    webhooks/        signatures, the inbox, dispatch, per-resource sequencing
    dead-letters/    listing and replaying dead jobs
    chaos/           per-sandbox chaos switches
    outbox/          transactional outbox and relay
    queue/           the job queue: claims, leases, backoff, outcomes, workers
    catalog/         the fictional demo catalog
    sim-payments/    the simulated payment provider
    sim-courier/     the simulated courier
packages/
  domain/            the order state machine (pure TypeScript)
  db/                schema, migrations, roles, connection helpers
  contracts/         request and response schemas shared with the console
docs/adr/            decision records
```

Node runs the TypeScript sources directly (type stripping), so the server has no build step.

## Decisions

- [ADR 001: Our own job queue on Postgres](docs/adr/001-own-job-queue.md)
- [ADR 002: Row level security with a non-owner app role](docs/adr/002-row-level-security.md)
- [ADR 003: Per-resource sequencing for out-of-order webhooks](docs/adr/003-out-of-order-webhooks.md)
