// Webhook signatures: HMAC-SHA256 over "<timestamp>.<raw body>", sent as
//   Sethu-Signature: t=<unix seconds>,v1=<hex>[,v1=<hex>...]
// Several v1 values let a provider sign with an old and a new secret while a
// secret is being rotated. The timestamp is signed too, so an attacker cannot
// refresh an old capture; the tolerance window bounds how long a captured
// request stays replayable, and the inbox's unique event id closes the rest.

import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADER = 'sethu-signature';
export const DEFAULT_TOLERANCE_SECONDS = 300;

export function computeSignature(secret: string, timestamp: number, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

export function signatureHeader(secrets: readonly string[], timestamp: number, body: string) {
  const parts = secrets.map((secret) => `v1=${computeSignature(secret, timestamp, body)}`);
  return [`t=${timestamp}`, ...parts].join(',');
}

export type VerifyFailure = 'missing' | 'malformed' | 'stale' | 'bad_signature';
export type VerifyResult = { ok: true; timestamp: number } | { ok: false; reason: VerifyFailure };

export interface VerifyInput {
  readonly header: string | undefined;
  readonly body: string;
  /** Every secret currently accepted (more than one during rotation). */
  readonly secrets: readonly string[];
  readonly nowSeconds?: number;
  readonly toleranceSeconds?: number;
}

export function verifySignature(input: VerifyInput): VerifyResult {
  if (input.header === undefined || input.header === '') return { ok: false, reason: 'missing' };

  let timestamp: number | undefined;
  const candidates: string[] = [];
  for (const part of input.header.split(',')) {
    const [key, value, ...rest] = part.trim().split('=');
    if (rest.length > 0 || key === undefined || value === undefined) {
      return { ok: false, reason: 'malformed' };
    }
    if (key === 't' && /^\d{1,12}$/.test(value)) timestamp = Number(value);
    if (key === 'v1' && /^[0-9a-f]{64}$/.test(value)) candidates.push(value);
  }
  if (timestamp === undefined || candidates.length === 0) return { ok: false, reason: 'malformed' };

  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (Math.abs(now - timestamp) > tolerance) return { ok: false, reason: 'stale' };

  const ts = timestamp;
  const matches = input.secrets.some((secret) => {
    const expected = Buffer.from(computeSignature(secret, ts, input.body), 'hex');
    return candidates.some((candidate) => {
      const given = Buffer.from(candidate, 'hex');
      return given.length === expected.length && timingSafeEqual(given, expected);
    });
  });
  return matches ? { ok: true, timestamp } : { ok: false, reason: 'bad_signature' };
}
