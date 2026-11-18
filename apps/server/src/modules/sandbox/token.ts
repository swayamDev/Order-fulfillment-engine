// A sandbox token is "<sandbox id>.<secret>.<mac>".
//
//   sandbox id  lets the API set app.sandbox_id before looking anything up, so
//               resolving a session runs under row level security as sethu_app
//               and needs no cross-sandbox query.
//   secret      32 random bytes. Only its SHA-256 is stored, and it must match.
//   mac         HMAC-SHA256 with a server key over "v1.<id>.<secret>". Checked
//               in constant time before any database work, against every
//               current key so keys can be rotated.
//
// Either check alone refuses a forged or edited cookie: changing the id breaks
// the mac, and a cookie signed with a leaked key still needs the secret.

import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const B64URL_32_BYTES = /^[A-Za-z0-9_-]{43}$/;
const VERSION = 'v1';

export interface SandboxToken {
  readonly sandboxId: string;
  readonly secret: string;
}

export function hashSecret(secret: string): Buffer {
  return createHash('sha256').update(secret).digest();
}

export class SandboxTokenCodec {
  private readonly keys: readonly string[];

  /** @param keys signing keys; the first signs, all verify. */
  constructor(keys: readonly string[]) {
    if (keys.length === 0) throw new Error('At least one session signing key is required');
    if (keys.some((key) => key.length < 32)) {
      throw new Error('Session signing keys must be at least 32 characters');
    }
    this.keys = keys;
  }

  issue(): { token: SandboxToken; value: string } {
    const token = { sandboxId: randomUUID(), secret: randomBytes(32).toString('base64url') };
    return { token, value: this.sign(token) };
  }

  sign(token: SandboxToken): string {
    const [key] = this.keys;
    if (key === undefined) throw new Error('unreachable: no signing key');
    return `${token.sandboxId}.${token.secret}.${mac(key, token)}`;
  }

  /** Returns the token only if it is well formed and its mac verifies. */
  verify(value: string | undefined): SandboxToken | undefined {
    if (value === undefined) return undefined;
    const [sandboxId, secret, given, ...rest] = value.split('.');
    if (rest.length > 0 || sandboxId === undefined || secret === undefined || given === undefined) {
      return undefined;
    }
    if (!UUID.test(sandboxId) || !B64URL_32_BYTES.test(secret) || !B64URL_32_BYTES.test(given)) {
      return undefined;
    }
    const token = { sandboxId, secret };
    const givenBytes = Buffer.from(given, 'base64url');
    const valid = this.keys.some((key) => {
      const expected = Buffer.from(mac(key, token), 'base64url');
      return expected.length === givenBytes.length && timingSafeEqual(expected, givenBytes);
    });
    return valid ? token : undefined;
  }
}

function mac(key: string, token: SandboxToken): string {
  return createHmac('sha256', key)
    .update(`${VERSION}.${token.sandboxId}.${token.secret}`)
    .digest('base64url');
}
