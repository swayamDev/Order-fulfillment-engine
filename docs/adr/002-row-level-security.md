# ADR 002: Row level security with a non-owner app role

Status: accepted, phase 1.

## Context

The public demo gives every visitor a sandbox: their own catalog copy, orders, jobs and webhooks, all in one database. A query that forgets to filter by sandbox must fail closed, not leak someone else's data.

Two Postgres details shape the design:

- A table's owner bypasses row level security unless the table uses `FORCE ROW LEVEL SECURITY`.
- On Neon, the project's default role owns the tables it creates.

## Decision

Three roles:

| Role                                                               | Login | Used for                                                              |
| ------------------------------------------------------------------ | ----- | --------------------------------------------------------------------- |
| Owner (`sethu_owner` locally, the Neon default role in production) | yes   | Migrations only                                                       |
| `sethu_app`                                                        | yes   | The API and every job handler. Owns nothing, no `BYPASSRLS`           |
| `sethu_system`                                                     | no    | Owns the `SECURITY DEFINER` functions that must work across sandboxes |

Every table has RLS enabled and forced, with one policy:

```sql
USING (sandbox_id = current_sandbox_id() OR current_user = 'sethu_system')
```

`current_sandbox_id()` reads `app.sandbox_id`, which the app sets per transaction with `set_config(..., true)`. When it is unset the function returns NULL, so nothing matches: no rows are visible and every insert fails its `WITH CHECK`. Forcing RLS means even the owner sees nothing without a sandbox.

`sethu_system` is used only where work genuinely crosses sandboxes:

- `claim_jobs` and `next_queue_wakeup`
- `reap_expired_leases`
- `claim_outbox`
- (later) the expiry sweeper

Nobody can log in as it, and the app can only call those functions. Job handlers never use it; they run as `sethu_app` inside the job's sandbox.

## Sessions without a cross-sandbox lookup

The sandbox cookie is `<sandbox id>.<secret>.<mac>`:

- the **mac** is HMAC-SHA256 under a server key (`SESSION_SIGNING_KEYS`; the first signs, all verify, so keys rotate) over the id and secret. It is checked in constant time on every request, before any database work;
- the API then sets `app.sandbox_id` from the id and matches the SHA-256 of the **secret** under RLS.

Each check alone refuses a forged cookie. Editing the id breaks the mac. A leaked signing key still needs the sandbox's secret. A stolen secret still needs the server's mac. Resolving a session needs no definer function at all.

The cookie is `__Host-sethu_sandbox`: httpOnly, Secure, SameSite=Lax, host-only on the API domain. Because every `*.swayam.space` host counts as the same site, writes also require the exact console `Origin` and a JSON body. In production the server refuses to start unless the signing keys and other secrets are set explicitly.

## Proof

- `rls.int.test.ts`:
  - the app role is not a superuser, has no `BYPASSRLS` and owns nothing;
  - every table has RLS enabled and forced;
  - with no sandbox set, all twelve tables return no rows, inserts fail and updates and deletes touch nothing;
  - the owner is filtered too;
  - sandboxes cannot read, write or move rows into each other;
  - the setting does not outlive its transaction on a reused connection.
- `queue.test.ts`: a job handler runs as `sethu_app` in its job's sandbox and cannot read, update or insert another sandbox's rows.

## Roles live outside migrations

`pnpm db:roles` creates the two roles and sets the app password. It runs as the owner, the same way locally, in CI and against Neon. Migrations only grant privileges, so no password is ever committed.
