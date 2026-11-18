import { withSandbox, type Db } from '@sethu/db';
import { sql } from 'kysely';
import { formatToken, hashSecret, newSandboxToken, type SandboxToken } from './token.ts';

export const SANDBOX_IDLE_TTL = '2 hours';
export const SANDBOX_HARD_TTL = '6 hours';
export const SANDBOX_HARD_TTL_SECONDS = 6 * 60 * 60;

export interface SandboxSession {
  readonly sandboxId: string;
  readonly expiresAt: Date;
  readonly hardExpiresAt: Date;
}

export async function createSandbox(db: Db): Promise<{ token: string; session: SandboxSession }> {
  const token = newSandboxToken();
  const row = await withSandbox(db, token.sandboxId, (tx) =>
    tx
      .insertInto('sandboxes')
      .values({
        id: token.sandboxId,
        token_hash: hashSecret(token.secret),
        expires_at: sql<Date>`now() + ${SANDBOX_IDLE_TTL}::interval`,
        hard_expires_at: sql<Date>`now() + ${SANDBOX_HARD_TTL}::interval`,
      })
      .returning(['id', 'expires_at', 'hard_expires_at'])
      .executeTakeFirstOrThrow(),
  );
  return {
    token: formatToken(token),
    session: { sandboxId: row.id, expiresAt: row.expires_at, hardExpiresAt: row.hard_expires_at },
  };
}

/**
 * Checks a token and slides the idle expiry forward, capped at the hard expiry.
 * Runs as sethu_app with app.sandbox_id taken from the token, so a forged id
 * can only ever match rows in the sandbox it names, and only with its secret.
 */
export async function resolveSandbox(
  db: Db,
  token: SandboxToken,
): Promise<SandboxSession | undefined> {
  const row = await withSandbox(db, token.sandboxId, (tx) =>
    tx
      .updateTable('sandboxes')
      .set({
        last_active_at: sql<Date>`now()`,
        expires_at: sql<Date>`least(now() + ${SANDBOX_IDLE_TTL}::interval, hard_expires_at)`,
      })
      .where('id', '=', token.sandboxId)
      .where('token_hash', '=', hashSecret(token.secret))
      .where('expires_at', '>', sql<Date>`now()`)
      .returning(['id', 'expires_at', 'hard_expires_at'])
      .executeTakeFirst(),
  );
  if (row === undefined) return undefined;
  return { sandboxId: row.id, expiresAt: row.expires_at, hardExpiresAt: row.hard_expires_at };
}
