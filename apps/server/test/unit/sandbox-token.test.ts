import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hashSecret, SandboxTokenCodec } from '../../src/modules/sandbox/token.ts';

const KEY = 'k'.repeat(40);
const NEW_KEY = 'n'.repeat(40);
const codec = new SandboxTokenCodec([KEY]);

const parts = (value: string) => {
  const [id = '', secret = '', mac = ''] = value.split('.');
  return { id, secret, mac };
};

describe('signed sandbox token', () => {
  it('round trips', () => {
    const { token, value } = codec.issue();
    expect(codec.verify(value)).toEqual(token);
    expect(value.split('.')).toHaveLength(3);
  });

  it('refuses a token whose id, secret or mac was edited', () => {
    const { value } = codec.issue();
    const { id, secret, mac } = parts(value);
    const flip = (s: string) => (s.startsWith('A') ? `B${s.slice(1)}` : `A${s.slice(1)}`);
    for (const edited of [
      `${randomUUID()}.${secret}.${mac}`,
      `${id}.${flip(secret)}.${mac}`,
      `${id}.${secret}.${flip(mac)}`,
    ]) {
      expect(codec.verify(edited), edited).toBeUndefined();
    }
  });

  it("refuses one sandbox's secret and mac presented with another sandbox's id", () => {
    const a = parts(codec.issue().value);
    const b = parts(codec.issue().value);
    expect(codec.verify(`${b.id}.${a.secret}.${a.mac}`)).toBeUndefined();
  });

  it('refuses a token signed with a key the server does not hold', () => {
    const forger = new SandboxTokenCodec(['f'.repeat(40)]);
    expect(codec.verify(forger.issue().value)).toBeUndefined();
  });

  it('refuses the old unsigned two-part format and other malformed values', () => {
    const { id, secret, mac } = parts(codec.issue().value);
    for (const value of [
      undefined,
      '',
      `${id}.${secret}`,
      `${id}.${secret}.${mac}.extra`,
      `${id.toUpperCase()}.${secret}.${mac}`,
      `not-a-uuid.${secret}.${mac}`,
      `${id}.${secret}.short`,
    ]) {
      expect(codec.verify(value), String(value)).toBeUndefined();
    }
  });

  it('accepts tokens signed with a previous key during rotation, and drops them after', () => {
    const { token, value } = codec.issue();
    expect(new SandboxTokenCodec([NEW_KEY, KEY]).verify(value)).toEqual(token);
    expect(new SandboxTokenCodec([NEW_KEY]).verify(value)).toBeUndefined();
  });

  it('rejects weak or missing keys', () => {
    expect(() => new SandboxTokenCodec([])).toThrow();
    expect(() => new SandboxTokenCodec(['short'])).toThrow();
  });

  it('hashes secrets to 32 bytes, deterministically', () => {
    const secret = randomBytes(32).toString('base64url');
    expect(hashSecret(secret)).toHaveLength(32);
    expect(hashSecret(secret).equals(hashSecret(secret))).toBe(true);
  });
});
