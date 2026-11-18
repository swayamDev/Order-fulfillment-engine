import { ORDER_STATES } from '@sethu/domain';
import { sql, type Kysely } from 'kysely';

// Every table that holds sandbox data gets the same treatment:
//   ENABLE + FORCE row level security, so even the table owner is filtered;
//   one policy that matches the transaction's app.sandbox_id;
//   an exception only for sethu_system, the no-login role that owns the few
//   SECURITY DEFINER functions allowed to work across sandboxes.
const SANDBOXED_TABLES = [
  'products',
  'stock',
  'orders',
  'order_items',
  'order_events',
  'reservations',
  'outbox',
  'jobs',
  'processed_messages',
  'webhook_inbox',
  'sim_payment_intents',
] as const;

const stateList = sql.join(ORDER_STATES.map((state) => sql.lit(state)));

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE FUNCTION current_sandbox_id() RETURNS uuid
    LANGUAGE sql STABLE
    AS $$ SELECT NULLIF(current_setting('app.sandbox_id', true), '')::uuid $$
  `.execute(db);

  await sql`
    CREATE TABLE sandboxes (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      token_hash      bytea NOT NULL UNIQUE,
      ip_hash         bytea,
      created_at      timestamptz NOT NULL DEFAULT now(),
      last_active_at  timestamptz NOT NULL DEFAULT now(),
      expires_at      timestamptz NOT NULL,
      hard_expires_at timestamptz NOT NULL,
      CHECK (expires_at <= hard_expires_at)
    )
  `.execute(db);

  await sql`
    CREATE TABLE products (
      sandbox_id  uuid NOT NULL REFERENCES sandboxes (id) ON DELETE CASCADE,
      sku         text NOT NULL,
      name        text NOT NULL,
      price_minor bigint NOT NULL CHECK (price_minor > 0),
      PRIMARY KEY (sandbox_id, sku)
    )
  `.execute(db);

  await sql`
    CREATE TABLE stock (
      sandbox_id uuid NOT NULL,
      sku        text NOT NULL,
      available  integer NOT NULL CHECK (available >= 0),
      reserved   integer NOT NULL DEFAULT 0 CHECK (reserved >= 0),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (sandbox_id, sku),
      FOREIGN KEY (sandbox_id, sku) REFERENCES products (sandbox_id, sku) ON DELETE CASCADE
    )
  `.execute(db);

  await sql`
    CREATE TABLE orders (
      id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      sandbox_id       uuid NOT NULL REFERENCES sandboxes (id) ON DELETE CASCADE,
      idempotency_key  text NOT NULL,
      request_hash     text NOT NULL,
      state            text NOT NULL CHECK (state IN (${stateList})),
      version          integer NOT NULL DEFAULT 1,
      currency         char(3) NOT NULL DEFAULT 'INR',
      total_minor      bigint NOT NULL CHECK (total_minor > 0),
      payment_captured boolean NOT NULL DEFAULT false,
      created_at       timestamptz NOT NULL DEFAULT now(),
      updated_at       timestamptz NOT NULL DEFAULT now(),
      UNIQUE (sandbox_id, idempotency_key)
    )
  `.execute(db);
  await sql`CREATE INDEX orders_sandbox_created_idx ON orders (sandbox_id, created_at DESC)`.execute(
    db,
  );

  await sql`
    CREATE TABLE order_items (
      order_id         uuid NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
      sandbox_id       uuid NOT NULL,
      line             integer NOT NULL,
      sku              text NOT NULL,
      quantity         integer NOT NULL CHECK (quantity > 0),
      unit_price_minor bigint NOT NULL CHECK (unit_price_minor > 0),
      PRIMARY KEY (order_id, line)
    )
  `.execute(db);

  await sql`
    CREATE TABLE order_events (
      id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      sandbox_id uuid NOT NULL,
      order_id   uuid NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
      seq        integer NOT NULL,
      kind       text NOT NULL,
      data       jsonb NOT NULL DEFAULT '{}',
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (order_id, seq)
    )
  `.execute(db);

  await sql`
    CREATE TABLE reservations (
      order_id   uuid PRIMARY KEY REFERENCES orders (id) ON DELETE CASCADE,
      sandbox_id uuid NOT NULL,
      status     text NOT NULL CHECK (status IN ('held', 'released', 'consumed')),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);

  await sql`
    CREATE TABLE outbox (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      sandbox_id   uuid NOT NULL REFERENCES sandboxes (id) ON DELETE CASCADE,
      topic        text NOT NULL,
      aggregate_id uuid NOT NULL,
      payload      jsonb NOT NULL,
      created_at   timestamptz NOT NULL DEFAULT now(),
      published_at timestamptz
    )
  `.execute(db);
  await sql`CREATE INDEX outbox_unpublished_idx ON outbox (created_at) WHERE published_at IS NULL`.execute(
    db,
  );

  await sql`
    CREATE TABLE jobs (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      sandbox_id   uuid NOT NULL REFERENCES sandboxes (id) ON DELETE CASCADE,
      queue        text NOT NULL,
      payload      jsonb NOT NULL,
      status       text NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued', 'running', 'succeeded', 'dead')),
      attempts     integer NOT NULL DEFAULT 0,
      max_attempts integer NOT NULL DEFAULT 6 CHECK (max_attempts > 0),
      run_at       timestamptz NOT NULL DEFAULT now(),
      locked_by    text,
      locked_until timestamptz,
      last_error   text,
      dedupe_key   text,
      created_at   timestamptz NOT NULL DEFAULT now(),
      updated_at   timestamptz NOT NULL DEFAULT now(),
      finished_at  timestamptz,
      UNIQUE (sandbox_id, dedupe_key),
      CHECK ((status = 'running') = (locked_until IS NOT NULL))
    )
  `.execute(db);
  await sql`CREATE INDEX jobs_due_idx ON jobs (run_at) WHERE status = 'queued'`.execute(db);
  await sql`CREATE INDEX jobs_leases_idx ON jobs (locked_until) WHERE status = 'running'`.execute(
    db,
  );

  await sql`
    CREATE TABLE processed_messages (
      consumer     text NOT NULL,
      message_id   uuid NOT NULL,
      sandbox_id   uuid NOT NULL REFERENCES sandboxes (id) ON DELETE CASCADE,
      processed_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (consumer, message_id)
    )
  `.execute(db);

  await sql`
    CREATE TABLE webhook_inbox (
      id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      sandbox_id        uuid NOT NULL REFERENCES sandboxes (id) ON DELETE CASCADE,
      provider          text NOT NULL,
      provider_event_id text NOT NULL,
      event_type        text NOT NULL,
      payload           jsonb NOT NULL,
      received_at       timestamptz NOT NULL DEFAULT now(),
      duplicate_count   integer NOT NULL DEFAULT 0,
      processed_at      timestamptz,
      UNIQUE (provider, provider_event_id)
    )
  `.execute(db);

  await sql`
    CREATE TABLE sim_payment_intents (
      id              text PRIMARY KEY,
      sandbox_id      uuid NOT NULL REFERENCES sandboxes (id) ON DELETE CASCADE,
      order_id        uuid NOT NULL,
      idempotency_key text NOT NULL,
      amount_minor    bigint NOT NULL CHECK (amount_minor > 0),
      currency        char(3) NOT NULL,
      status          text NOT NULL CHECK (status IN ('authorized', 'captured', 'failed')),
      created_at      timestamptz NOT NULL DEFAULT now(),
      updated_at      timestamptz NOT NULL DEFAULT now(),
      UNIQUE (sandbox_id, idempotency_key)
    )
  `.execute(db);

  // Row level security.
  await sql`ALTER TABLE sandboxes ENABLE ROW LEVEL SECURITY`.execute(db);
  await sql`ALTER TABLE sandboxes FORCE ROW LEVEL SECURITY`.execute(db);
  await sql`
    CREATE POLICY sandbox_isolation ON sandboxes
      USING (id = current_sandbox_id() OR current_user = 'sethu_system')
      WITH CHECK (id = current_sandbox_id() OR current_user = 'sethu_system')
  `.execute(db);

  for (const table of SANDBOXED_TABLES) {
    const t = sql.table(table);
    await sql`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`.execute(db);
    await sql`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`.execute(db);
    await sql`
      CREATE POLICY sandbox_isolation ON ${t}
        USING (sandbox_id = current_sandbox_id() OR current_user = 'sethu_system')
        WITH CHECK (sandbox_id = current_sandbox_id() OR current_user = 'sethu_system')
    `.execute(db);
  }

  // Privileges. Neither role owns anything; both are filtered by the policies.
  await sql`GRANT USAGE ON SCHEMA public TO sethu_app, sethu_system`.execute(db);
  // Needed so ownership of definer functions can be handed to sethu_system.
  await sql`GRANT CREATE ON SCHEMA public TO sethu_system`.execute(db);
  for (const table of ['sandboxes', ...SANDBOXED_TABLES]) {
    await sql`GRANT SELECT, INSERT, UPDATE, DELETE ON ${sql.table(table)} TO sethu_app, sethu_system`.execute(
      db,
    );
  }
  await sql`GRANT EXECUTE ON FUNCTION current_sandbox_id() TO sethu_app, sethu_system`.execute(db);
}
