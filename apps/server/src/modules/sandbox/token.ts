// A sandbox token is "<sandbox id>.<secret>". The id lets the API set
// app.sandbox_id before looking anything up, so resolving a visitor's sandbox
// runs under row level security as sethu_app and never needs a cross-sandbox
// query. Only the SHA-256 of the secret is stored.

import { createHash, randomBytes, randomUUID } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/; // 32 bytes, base64url without padding

export interface SandboxToken {
  readonly sandboxId: string;
  readonly secret: string;
}

export function newSandboxToken(): SandboxToken {
  return { sandboxId: randomUUID(), secret: randomBytes(32).toString('base64url') };
}

export function formatToken(token: SandboxToken): string {
  return `${token.sandboxId}.${token.secret}`;
}

export function parseToken(value: string | undefined): SandboxToken | undefined {
  if (value === undefined) return undefined;
  const [sandboxId, secret, ...rest] = value.split('.');
  if (rest.length > 0 || sandboxId === undefined || secret === undefined) return undefined;
  if (!UUID.test(sandboxId) || !SECRET.test(secret)) return undefined;
  return { sandboxId, secret };
}

export function hashSecret(secret: string): Buffer {
  return createHash('sha256').update(secret).digest();
}
