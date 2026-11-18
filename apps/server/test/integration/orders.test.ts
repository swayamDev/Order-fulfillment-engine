import type { OrderView } from '@sethu/contracts';
import { withSandbox } from '@sethu/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { consoleJson, newSandbox, startHarness, type Harness } from './harness.ts';

let h: Harness;

beforeAll(async () => {
  h = await startHarness();
});

afterAll(async () => {
  await h.close();
});

const twoItems = {
  items: [
    { sku: 'TEA-ASSAM-250', quantity: 2 },
    { sku: 'MUG-STONE-01', quantity: 1 },
  ],
};

function place(cookie: string, key: string | undefined, body: unknown = twoItems) {
  return h.app.inject({
    method: 'POST',
    url: '/v1/orders',
    headers: { ...consoleJson, cookie, ...(key === undefined ? {} : { 'idempotency-key': key }) },
    payload: body as Record<string, unknown>,
  });
}

async function countRows(sandboxId: string) {
  return withSandbox(h.owner, sandboxId, async (tx) => ({
    orders: (await tx.selectFrom('orders').select('id').execute()).length,
    placedEvents: (
      await tx.selectFrom('outbox').select('id').where('topic', '=', 'order.placed').execute()
    ).length,
  }));
}

describe('POST /v1/orders', () => {
  it('places an order, logs it, and publishes order.placed in one transaction', async () => {
    const { cookie, id: sandboxId } = await newSandbox(h.app);
    const response = await place(cookie, 'checkout-0001');
    expect(response.statusCode).toBe(201);

    const order = response.json<OrderView>();
    expect(order).toMatchObject({
      state: 'placed',
      version: 1,
      currency: 'INR',
      totalMinor: 2 * 42_000 + 89_000,
      paymentCaptured: false,
      idempotencyKey: 'checkout-0001',
    });
    expect(order.items.map((i) => [i.sku, i.quantity])).toEqual([
      ['TEA-ASSAM-250', 2],
      ['MUG-STONE-01', 1],
    ]);
    expect(order.events).toEqual([
      expect.objectContaining({
        seq: 1,
        kind: 'transition',
        data: { from: null, to: 'placed', via: 'api', idempotencyKey: 'checkout-0001' },
      }),
    ]);
    expect(await countRows(sandboxId)).toEqual({ orders: 1, placedEvents: 1 });
  });

  it('returns the original order for a retry with the same key and body', async () => {
    const { cookie, id: sandboxId } = await newSandbox(h.app);
    const first = await place(cookie, 'retry-me-0001');
    // Same meaning, different item order: still the same request.
    const second = await place(cookie, 'retry-me-0001', {
      items: [...twoItems.items].reverse(),
    });
    expect(second.statusCode).toBe(200);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.json<OrderView>().id).toBe(first.json<OrderView>().id);
    expect(await countRows(sandboxId)).toEqual({ orders: 1, placedEvents: 1 });
  });

  it('rejects the same key with a different body', async () => {
    const { cookie } = await newSandbox(h.app);
    await place(cookie, 'reused-key-0001');
    const response = await place(cookie, 'reused-key-0001', {
      items: [{ sku: 'TEA-ASSAM-250', quantity: 3 }],
    });
    expect(response.statusCode).toBe(422);
    expect(response.json<{ type: string }>().type).toBe('idempotency_key_reused');
  });

  it('creates exactly one order when ten identical requests race', async () => {
    const { cookie, id: sandboxId } = await newSandbox(h.app);
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => place(cookie, 'double-click-0001')),
    );
    const codes = responses.map((r) => r.statusCode).sort();
    expect(codes).toEqual([200, 200, 200, 200, 200, 200, 200, 200, 200, 201]);
    expect(new Set(responses.map((r) => r.json<OrderView>().id)).size).toBe(1);
    expect(await countRows(sandboxId)).toEqual({ orders: 1, placedEvents: 1 });
  });

  it('scopes keys to the sandbox', async () => {
    const a = await newSandbox(h.app);
    const b = await newSandbox(h.app);
    const inA = await place(a.cookie, 'shared-key-0001');
    const inB = await place(b.cookie, 'shared-key-0001');
    expect([inA.statusCode, inB.statusCode]).toEqual([201, 201]);
    expect(inA.json<OrderView>().id).not.toBe(inB.json<OrderView>().id);
  });

  it('requires a well-formed Idempotency-Key', async () => {
    const { cookie } = await newSandbox(h.app);
    for (const key of [undefined, 'short', 'has spaces in it', 'x'.repeat(101)]) {
      const response = await place(cookie, key);
      expect(response.statusCode, key).toBe(400);
      expect(response.json<{ type: string }>().type).toBe('idempotency_key_required');
    }
  });

  it('validates the body', async () => {
    const { cookie } = await newSandbox(h.app);
    for (const body of [
      {},
      { items: [] },
      { items: [{ sku: 'TEA-ASSAM-250', quantity: 0 }] },
      { items: [{ sku: 'TEA-ASSAM-250', quantity: 11 }] },
      {
        items: [
          { sku: 'TEA-ASSAM-250', quantity: 1 },
          { sku: 'TEA-ASSAM-250', quantity: 1 },
        ],
      },
    ]) {
      const response = await place(cookie, 'validation-0001', body);
      expect(response.statusCode, JSON.stringify(body)).toBe(400);
    }
  });

  it('rejects unknown SKUs', async () => {
    const { cookie } = await newSandbox(h.app);
    const response = await place(cookie, 'unknown-sku-0001', {
      items: [{ sku: 'NOT-A-REAL-THING', quantity: 1 }],
    });
    expect(response.statusCode).toBe(422);
    expect(response.json<{ skus: string[] }>().skus).toEqual(['NOT-A-REAL-THING']);
  });

  it('requires a sandbox', async () => {
    const response = await h.app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: { ...consoleJson, 'idempotency-key': 'no-sandbox-0001' },
      payload: twoItems,
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('GET /v1/orders/:id', () => {
  it("returns 404 for another sandbox's order", async () => {
    const a = await newSandbox(h.app);
    const b = await newSandbox(h.app);
    const order = (await place(a.cookie, 'private-0001')).json<OrderView>();

    const own = await h.app.inject({
      method: 'GET',
      url: `/v1/orders/${order.id}`,
      headers: { cookie: a.cookie },
    });
    const other = await h.app.inject({
      method: 'GET',
      url: `/v1/orders/${order.id}`,
      headers: { cookie: b.cookie },
    });
    expect(own.statusCode).toBe(200);
    expect(other.statusCode).toBe(404);
  });
});
