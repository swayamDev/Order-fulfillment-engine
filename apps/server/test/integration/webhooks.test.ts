import { randomUUID } from 'node:crypto';
import { withSandbox, type Db } from '@sethu/db';
import { appDb, ownerDb } from '@sethu/db/testing';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { signatureHeader } from '../../src/modules/webhooks/index.ts';
import { CONSOLE_ORIGIN, newSandbox } from './harness.ts';

const SECRET = 'test-sim-payments-secret-000000000000';
const ROTATED = 'test-sim-payments-secret-111111111111';

let app: FastifyInstance;
let db: Db;
let owner: Db;
let wakeups = 0;

beforeAll(async () => {
  db = appDb();
  owner = ownerDb();
  app = await buildApp({
    config: { CONSOLE_ORIGIN },
    db,
    webhookSecrets: new Map([['sim-payments', [SECRET, ROTATED]]]),
    onEventsCommitted: () => {
      wakeups++;
    },
  });
});

afterAll(async () => {
  await app.close();
  await db.destroy();
  await owner.destroy();
});

function envelope(sandboxId: string, id = `evt_${randomUUID()}`) {
  return {
    id,
    type: 'payment.authorized',
    created: Math.floor(Date.now() / 1000),
    sandbox_id: sandboxId,
    data: { intent: 'pi_123' },
  };
}

function deliver(
  body: string,
  { secrets = [SECRET], at = Math.floor(Date.now() / 1000), provider = 'sim-payments' } = {},
) {
  return app.inject({
    method: 'POST',
    url: `/v1/webhooks/${provider}`,
    // No Origin header: providers are servers, not the console.
    headers: {
      'content-type': 'application/json',
      'sethu-signature': signatureHeader(secrets, at, body),
    },
    payload: body,
  });
}

async function inbox(sandboxId: string) {
  return withSandbox(owner, sandboxId, async (tx) => ({
    rows: await tx.selectFrom('webhook_inbox').selectAll().execute(),
    jobs: await tx.selectFrom('jobs').selectAll().where('queue', '=', 'webhook.process').execute(),
  }));
}

describe('webhook receiver', () => {
  it('stores a signed event once and queues it for processing', async () => {
    const { id: sandbox } = await newSandbox(app);
    const event = envelope(sandbox);
    const before = wakeups;
    const response = await deliver(JSON.stringify(event));

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true, duplicate: false });
    const { rows, jobs } = await inbox(sandbox);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: 'sim-payments',
      provider_event_id: event.id,
      event_type: 'payment.authorized',
      duplicate_count: 0,
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.payload).toMatchObject({ inboxId: rows[0]?.id });
    expect(wakeups).toBe(before + 1);
  });

  it('acknowledges a redelivered event without storing or queueing it again', async () => {
    const { id: sandbox } = await newSandbox(app);
    const body = JSON.stringify(envelope(sandbox));
    await deliver(body);
    const again = await deliver(body);
    const thirdTime = await deliver(body);

    expect(again.json()).toEqual({ received: true, duplicate: true });
    expect(thirdTime.statusCode).toBe(200);
    const { rows, jobs } = await inbox(sandbox);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.duplicate_count).toBe(2);
    expect(jobs).toHaveLength(1);
  });

  it('accepts the rotated secret', async () => {
    const { id: sandbox } = await newSandbox(app);
    const response = await deliver(JSON.stringify(envelope(sandbox)), { secrets: [ROTATED] });
    expect(response.statusCode).toBe(200);
  });

  it('rejects a bad signature and stores nothing', async () => {
    const { id: sandbox } = await newSandbox(app);
    const response = await deliver(JSON.stringify(envelope(sandbox)), {
      secrets: ['not-the-secret-0000000000000000000000'],
    });
    expect(response.statusCode).toBe(401);
    expect(response.json<{ detail: string }>().detail).toContain('bad_signature');
    expect((await inbox(sandbox)).rows).toEqual([]);
  });

  it('rejects a captured request replayed after the tolerance window', async () => {
    const { id: sandbox } = await newSandbox(app);
    const tenMinutesAgo = Math.floor(Date.now() / 1000) - 600;
    const response = await deliver(JSON.stringify(envelope(sandbox)), { at: tenMinutesAgo });
    expect(response.statusCode).toBe(401);
    expect(response.json<{ detail: string }>().detail).toContain('stale');
  });

  it('rejects a body altered in transit', async () => {
    const { id: sandbox } = await newSandbox(app);
    const body = JSON.stringify(envelope(sandbox));
    const response = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/sim-payments',
      headers: {
        'content-type': 'application/json',
        'sethu-signature': signatureHeader([SECRET], Math.floor(Date.now() / 1000), body),
      },
      payload: body.replace('pi_123', 'pi_999'),
    });
    expect(response.statusCode).toBe(401);
  });

  it('rejects unknown providers, malformed envelopes and dead sandboxes', async () => {
    const { id: sandbox } = await newSandbox(app);
    expect(
      (await deliver(JSON.stringify(envelope(sandbox)), { provider: 'nope' })).statusCode,
    ).toBe(404);
    expect((await deliver('{"not":"an envelope"}')).statusCode).toBe(400);
    expect((await deliver('not json')).statusCode).toBe(400);

    await withSandbox(owner, sandbox, (tx) =>
      tx
        .updateTable('sandboxes')
        .set({ expires_at: sql<Date>`now() - interval '1 second'` })
        .execute(),
    );
    const expired = await deliver(JSON.stringify(envelope(sandbox)));
    expect(expired.statusCode).toBe(404);
    const missing = await deliver(JSON.stringify(envelope(randomUUID())));
    expect(missing.statusCode).toBe(404);
  });
});
