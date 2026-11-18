import { describe, expect, it } from 'vitest';
import {
  formatToken,
  hashSecret,
  newSandboxToken,
  parseToken,
} from '../../src/modules/sandbox/token.ts';

describe('sandbox token', () => {
  it('round trips', () => {
    const token = newSandboxToken();
    expect(parseToken(formatToken(token))).toEqual(token);
  });

  it('rejects malformed values', () => {
    const { sandboxId, secret } = newSandboxToken();
    for (const value of [
      undefined,
      '',
      sandboxId,
      `${sandboxId}.`,
      `${sandboxId}.${secret}.extra`,
      `not-a-uuid.${secret}`,
      `${sandboxId}.short`,
      `${sandboxId.toUpperCase()}.${secret}`,
      `${sandboxId}.${secret.slice(0, -1)}=`,
    ]) {
      expect(parseToken(value), value).toBeUndefined();
    }
  });

  it('hashes secrets to 32 bytes, deterministically', () => {
    const { secret } = newSandboxToken();
    expect(hashSecret(secret)).toHaveLength(32);
    expect(hashSecret(secret).equals(hashSecret(secret))).toBe(true);
  });
});
