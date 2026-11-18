import type { Db } from '@sethu/db';
import { appDb, ownerDb } from '@sethu/db/testing';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../../src/app.ts';
import { SANDBOX_COOKIE } from '../../src/modules/sandbox/index.ts';

export const CONSOLE_ORIGIN = 'https://sethu.test';

export interface Harness {
  app: FastifyInstance;
  db: Db;
  owner: Db;
  close(): Promise<void>;
}

export async function startHarness(): Promise<Harness> {
  const db = appDb();
  const owner = ownerDb();
  const app = await buildApp({ config: { CONSOLE_ORIGIN }, db });
  return {
    app,
    db,
    owner,
    async close() {
      await app.close();
      await db.destroy();
      await owner.destroy();
    },
  };
}

/** Headers a browser on the console origin would send with a JSON write. */
export const consoleJson = { origin: CONSOLE_ORIGIN, 'content-type': 'application/json' };

export function sandboxCookie(response: LightMyRequestResponse): string {
  const cookie = response.cookies.find((c) => c.name === SANDBOX_COOKIE);
  if (cookie === undefined) throw new Error('Response did not set the sandbox cookie');
  return `${SANDBOX_COOKIE}=${cookie.value}`;
}

/** Starts a sandbox through the public API and returns its cookie header. */
export async function newSandbox(app: FastifyInstance): Promise<{ cookie: string; id: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/sandboxes',
    headers: consoleJson,
    payload: {},
  });
  if (response.statusCode !== 201) throw new Error(`Sandbox not created: ${response.body}`);
  return { cookie: sandboxCookie(response), id: response.json<{ sandboxId: string }>().sandboxId };
}
