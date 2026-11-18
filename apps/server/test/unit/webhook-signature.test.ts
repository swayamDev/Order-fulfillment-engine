import { describe, expect, it } from 'vitest';
import {
  computeSignature,
  signatureHeader,
  verifySignature,
} from '../../src/modules/webhooks/signature.ts';

const secret = 'a'.repeat(40);
const nextSecret = 'b'.repeat(40);
const body = '{"id":"evt_1","type":"payment.authorized"}';
const now = 1_800_000_000;

const verify = (
  header: string | undefined,
  overrides: Partial<{ body: string; secrets: string[]; nowSeconds: number }> = {},
) => verifySignature({ header, body, secrets: [secret], nowSeconds: now, ...overrides });

describe('webhook signatures', () => {
  it('accepts a correctly signed body', () => {
    expect(verify(signatureHeader([secret], now, body))).toEqual({ ok: true, timestamp: now });
  });

  it('rejects a body changed after signing', () => {
    const header = signatureHeader([secret], now, body);
    expect(verify(header, { body: body.replace('evt_1', 'evt_2') })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('rejects a signature made with another secret', () => {
    expect(verify(signatureHeader(['c'.repeat(40)], now, body))).toMatchObject({
      reason: 'bad_signature',
    });
  });

  it('rejects a timestamp that was changed after signing', () => {
    const signed = computeSignature(secret, now - 10, body);
    expect(verify(`t=${now},v1=${signed}`)).toMatchObject({ reason: 'bad_signature' });
  });

  it('accepts either secret during a rotation', () => {
    const signedWithNew = signatureHeader([nextSecret], now, body);
    expect(verify(signedWithNew, { secrets: [secret, nextSecret] }).ok).toBe(true);
    // A provider may also send both signatures at once.
    const both = signatureHeader([secret, nextSecret], now, body);
    expect(verify(both, { secrets: [nextSecret] }).ok).toBe(true);
  });

  it('rejects requests outside the five minute window, in either direction', () => {
    expect(verify(signatureHeader([secret], now - 301, body))).toMatchObject({ reason: 'stale' });
    expect(verify(signatureHeader([secret], now + 301, body))).toMatchObject({ reason: 'stale' });
    expect(verify(signatureHeader([secret], now - 299, body)).ok).toBe(true);
  });

  it('reports missing and malformed headers', () => {
    expect(verify(undefined)).toMatchObject({ reason: 'missing' });
    expect(verify('')).toMatchObject({ reason: 'missing' });
    for (const header of ['garbage', 't=abc,v1=00', `t=${now}`, `v1=${'0'.repeat(64)}`, 't==1']) {
      expect(verify(header), header).toMatchObject({ reason: 'malformed' });
    }
  });
});
