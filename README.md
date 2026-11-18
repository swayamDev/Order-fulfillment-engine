# Sethu

An event-driven order fulfillment engine for a fictional online store, with an internal operations console.

Sethu takes an order from placement to payment through a chain of small, independent steps. Every step is a database transaction that can crash, be retried or be delivered twice without double-reserving stock or double-charging a customer. The payment provider is simulated, and labelled so everywhere, so that failures can be produced on demand and the recovery watched.

**Status: phase 1 of 5.** The engine core works end to end without a UI: placed, inventory reserved, payment pending, paid. Packing, shipping, compensation paths, the console, the chaos panel and the public demo come in later phases.

## How an order moves

```
 API request                         worker (job handler)                  simulated provider
 ───────────                         ────────────────────                  ──────────────────
 POST /v1/orders
  └ one transaction:
     order + items + timeline
     + outbox event order.placed
                │
          outbox relay ──► job: inventory.reserve
                              └ lock order, lock stock rows (SKU order)
                                reserve all lines or none
                                + outbox event order.inventory_reserved
                │
          outbox relay ──► job: payments.request
                              └ create intent (idempotency key) ─────────► POST /sim/payments/v1/intents
                                + order -> payment_pending                       │
                                                                                 ▼
 POST /v1/webhooks/sim-payments ◄──────────────── signed webhooks, delivered later, retried on failure
  └ verify HMAC signature and timestamp
    store once in webhook_inbox
    + job: webhook.process ─────────► └ lock order, apply payment.captured
                                        order -> paid
```

## Guarantees, and the tests that prove them

| Guarantee                                    | How                                                                                                             | Test                                              |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| No event is lost or invented                 | Transactional outbox: events commit with the state change                                                       | `outbox.test.ts`                                  |
| A job runs to completion once                | `FOR UPDATE SKIP LOCKED` claims, leases, a reaper for crashed workers, a row lock that fences out stale workers | `queue.test.ts`: 8 workers, 1,000 jobs, each once |
| Redelivery is harmless                       | Consumers record `(consumer, message id)` in the same transaction as their effects                              | `outbox.test.ts`, `inventory.test.ts`             |
| No oversell                                  | Stock rows locked in SKU order, all-or-nothing reservation, `CHECK (available >= 0)`                            | `inventory.test.ts`: 10 orders race for 2 kettles |
| A double click places one order              | `Idempotency-Key`, unique per sandbox, request hash compared on replay                                          | `orders.test.ts`: 10 identical requests race      |
| A crash after charging does not charge twice | Provider call carries an idempotency key derived from the order                                                 | `payments.test.ts`                                |
| Forged or replayed webhooks are rejected     | HMAC-SHA256 over timestamp and raw body, 5 minute window, unique event id, secret rotation                      | `webhooks.test.ts`, `webhook-signature.test.ts`   |
| Only allowed transitions happen              | The state machine is a table; every one of the 169 state pairs is tested                                        | `order-state.test.ts`                             |
| One visitor cannot see another's data        | Postgres row level security, forced, with the app running as a non-owner role                                   | `rls.int.test.ts`, `queue.test.ts`                |
| Retries do not stampede                      | Exponential backoff with full jitter, then a dead-letter status                                                 | `backoff.test.ts`, `queue.test.ts`                |

## Running it locally

Requires Node 24 or later, pnpm and Docker.

```sh
pnpm install
cp .env.example .env
pnpm db:up          # Postgres 17 on port 54329
pnpm db:roles       # creates sethu_app and sethu_system
pnpm db:migrate     # runs as the owner role
pnpm dev            # API, outbox relay and workers on http://localhost:4000
```

Try an order (the console is not built yet, so this uses curl and a cookie jar):

```sh
curl -c jar -b jar -X POST localhost:4000/v1/sandboxes \
  -H 'origin: http://localhost:3000' -H 'content-type: application/json' -d '{}'

curl -c jar -b jar -X POST localhost:4000/v1/orders \
  -H 'origin: http://localhost:3000' -H 'content-type: application/json' \
  -H 'idempotency-key: my-first-order' \
  -d '{"items":[{"sku":"MUG-STONE-01","quantity":2}]}'

# A few seconds later, once the simulated webhooks have arrived:
curl -b jar localhost:4000/v1/orders/<order id>
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
  app.ts, main.ts, engine.ts     HTTP app, process entry, wiring of consumers to events
  modules/
    sandbox/       visitor sandboxes and the session cookie
    orders/        placing orders, the order timeline, state transitions
    inventory/     stock reservation
    payments/      payment requests and payment webhooks
    webhooks/      signature verification, the inbox, dispatch
    outbox/        transactional outbox and relay
    queue/         the job queue: claims, leases, backoff, workers
    catalog/       the fictional demo catalog
    sim-payments/  the simulated payment provider
packages/
  domain/          the order state machine (pure TypeScript)
  db/              schema, migrations, roles, connection helpers
  contracts/       request and response schemas shared with the console
docs/adr/          decision records
```

Node runs the TypeScript sources directly (type stripping), so the server has no build step.

## Decisions

- [ADR 001: Our own job queue on Postgres](docs/adr/001-own-job-queue.md)
- [ADR 002: Row level security with a non-owner app role](docs/adr/002-row-level-security.md)
