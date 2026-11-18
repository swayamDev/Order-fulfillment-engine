import { withSandbox } from '@sethu/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SANDBOX_COOKIE, SandboxTokenCodec } from '../../src/modules/sandbox/index.ts';
import {
  CONSOLE_ORIGIN,
  consoleJson,
  newSandbox,
  sandboxCookie,
  startHarness,
  TEST_SESSION_KEY,
  type Harness,
} from './harness.ts';

let h: Harness;

beforeAll(async () => {
  h = await startHarness();
});

afterAll(async () => {
  await h.close();
});

describe('sandbox session', () => {
  it('creates a sandbox and sets a host-only, httpOnly, Secure, Lax cookie', async () => {
    const response = await h.app.inject({
      method: 'POST',
      url: '/v1/sandboxes',
      headers: consoleJson,
      payload: {},
    });
    expect(response.statusCode).toBe(201);

    const cookie = response.cookies.find((c) => c.name === SANDBOX_COOKIE);
    expect(cookie).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: 6 * 60 * 60,
    });
    expect(cookie?.domain).toBeUndefined();

    const body = response.json<{ sandboxId: string; expiresAt: string; hardExpiresAt: string }>();
    expect(cookie?.value.startsWith(`${body.sandboxId}.`)).toBe(true);
    const idleMs = Date.parse(body.expiresAt) - Date.now();
    const hardMs = Date.parse(body.hardExpiresAt) - Date.now();
    expect(idleMs).toBeGreaterThan(119 * 60_000);
    expect(hardMs).toBeGreaterThan(359 * 60_000);
  });

  it('stores only a hash of the secret', async () => {
    const { cookie, id } = await newSandbox(h.app);
    const secret = cookie.split('.')[1] ?? '';
    const row = await withSandbox(h.owner, id, (tx) =>
      tx.selectFrom('sandboxes').select('token_hash').executeTakeFirstOrThrow(),
    );
    expect(row.token_hash.length).toBe(32);
    expect(row.token_hash.toString('base64url')).not.toBe(secret);
  });

  it('reuses a live sandbox instead of creating another', async () => {
    const { cookie, id } = await newSandbox(h.app);
    const again = await h.app.inject({
      method: 'POST',
      url: '/v1/sandboxes',
      headers: { ...consoleJson, cookie },
      payload: {},
    });
    expect(again.statusCode).toBe(200);
    expect(again.json<{ sandboxId: string }>().sandboxId).toBe(id);
  });

  it('resolves the current sandbox from the cookie', async () => {
    const { cookie, id } = await newSandbox(h.app);
    const response = await h.app.inject({
      method: 'GET',
      url: '/v1/sandboxes/current',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ sandboxId: string }>().sandboxId).toBe(id);
  });

  it('refuses edited and forged cookies and never resolves them to another sandbox', async () => {
    const a = await newSandbox(h.app);
    const b = await newSandbox(h.app);
    const value = (cookie: string) => cookie.slice(SANDBOX_COOKIE.length + 1);
    const [aId = '', aSecret = '', aMac = ''] = value(a.cookie).split('.');
    const [bId = '', bSecret = '', bMac = ''] = value(b.cookie).split('.');
    const flip = (s: string) => (s.startsWith('A') ? `B${s.slice(1)}` : `A${s.slice(1)}`);
    const serverKey = new SandboxTokenCodec([TEST_SESSION_KEY]);
    const attackerKey = new SandboxTokenCodec(['attacker-key-00000000000000000000000000']);

    const forgeries = {
      'no cookie': undefined,
      nonsense: 'nonsense',
      "A's secret and mac with B's id": `${bId}.${aSecret}.${aMac}`,
      "B's secret with A's id and mac": `${aId}.${bSecret}.${aMac}`,
      "B's mac on A's id and secret": `${aId}.${aSecret}.${bMac}`,
      'flipped mac': `${aId}.${aSecret}.${flip(aMac)}`,
      'flipped secret': `${aId}.${flip(aSecret)}.${aMac}`,
      'old unsigned format with a real secret': `${aId}.${aSecret}`,
      // A leaked signing key alone is not enough: the secret must still match.
      "server-signed, B's id, invented secret": serverKey.sign({
        sandboxId: bId,
        secret: 'x'.repeat(43),
      }),
      // A stolen secret alone is not enough: the mac must be the server's.
      "B's real id and secret, attacker's key": attackerKey.sign({
        sandboxId: bId,
        secret: bSecret,
      }),
    };

    for (const [label, forged] of Object.entries(forgeries)) {
      const response = await h.app.inject({
        method: 'GET',
        url: '/v1/sandboxes/current',
        headers: forged === undefined ? {} : { cookie: `${SANDBOX_COOKIE}=${forged}` },
      });
      expect(response.statusCode, label).toBe(401);
      expect(response.json<{ type: string }>().type, label).toBe('no_sandbox');
      expect(response.body, label).not.toContain(b.id);
    }

    // And the genuine cookies still work, each for its own sandbox.
    for (const own of [a, b]) {
      const response = await h.app.inject({
        method: 'GET',
        url: '/v1/sandboxes/current',
        headers: { cookie: own.cookie },
      });
      expect(response.json<{ sandboxId: string }>().sandboxId).toBe(own.id);
    }
  });

  it('checks the signature on sandbox-scoped routes too, not just the session route', async () => {
    const a = await newSandbox(h.app);
    const b = await newSandbox(h.app);
    const [, aSecret = '', aMac = ''] = a.cookie.slice(SANDBOX_COOKIE.length + 1).split('.');
    const response = await h.app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: {
        ...consoleJson,
        'idempotency-key': 'forged-order-0001',
        cookie: `${SANDBOX_COOKIE}=${b.id}.${aSecret}.${aMac}`,
      },
      payload: { items: [{ sku: 'TEA-ASSAM-250', quantity: 1 }] },
    });
    expect(response.statusCode).toBe(401);
    const ordersInB = await withSandbox(h.owner, b.id, (tx) =>
      tx.selectFrom('orders').select('id').execute(),
    );
    expect(ordersInB).toEqual([]);
  });

  it('rejects an expired sandbox', async () => {
    const { cookie, id } = await newSandbox(h.app);
    await withSandbox(h.owner, id, (tx) =>
      tx
        .updateTable('sandboxes')
        .set({ expires_at: sql<Date>`now() - interval '1 second'` })
        .execute(),
    );
    const response = await h.app.inject({
      method: 'GET',
      url: '/v1/sandboxes/current',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(401);
  });

  it('slides the idle expiry forward but never past the hard expiry', async () => {
    const { cookie, id } = await newSandbox(h.app);
    await withSandbox(h.owner, id, (tx) =>
      tx
        .updateTable('sandboxes')
        .set({
          expires_at: sql<Date>`now() + interval '1 minute'`,
          hard_expires_at: sql<Date>`now() + interval '30 minutes'`,
        })
        .execute(),
    );
    const response = await h.app.inject({
      method: 'GET',
      url: '/v1/sandboxes/current',
      headers: { cookie },
    });
    const body = response.json<{ expiresAt: string; hardExpiresAt: string }>();
    expect(body.expiresAt).toBe(body.hardExpiresAt);
  });
});

describe('write guards and CORS', () => {
  it('rejects writes without the console origin', async () => {
    for (const origin of [undefined, 'https://evil.swayam.space', 'https://sethu.test.evil']) {
      const response = await h.app.inject({
        method: 'POST',
        url: '/v1/sandboxes',
        headers: {
          'content-type': 'application/json',
          ...(origin === undefined ? {} : { origin }),
        },
        payload: {},
      });
      expect(response.statusCode, origin).toBe(403);
    }
  });

  it('rejects writes that are not JSON', async () => {
    const response = await h.app.inject({
      method: 'POST',
      url: '/v1/sandboxes',
      headers: { origin: CONSOLE_ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'a=1',
    });
    expect(response.statusCode).toBe(415);
  });

  it('allows credentialed CORS from the console origin only', async () => {
    const preflight = (origin: string) =>
      h.app.inject({
        method: 'OPTIONS',
        url: '/v1/sandboxes',
        headers: {
          origin,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type',
        },
      });

    const ok = await preflight(CONSOLE_ORIGIN);
    expect(ok.headers['access-control-allow-origin']).toBe(CONSOLE_ORIGIN);
    expect(ok.headers['access-control-allow-credentials']).toBe('true');

    const other = await preflight('https://evil.swayam.space');
    expect(other.headers['access-control-allow-origin']).not.toBe('https://evil.swayam.space');
  });

  it('sends the cookie back on a reused session', async () => {
    const response = await h.app.inject({
      method: 'POST',
      url: '/v1/sandboxes',
      headers: consoleJson,
      payload: {},
    });
    expect(sandboxCookie(response)).toMatch(new RegExp(`^${SANDBOX_COOKIE}=`));
  });
});
