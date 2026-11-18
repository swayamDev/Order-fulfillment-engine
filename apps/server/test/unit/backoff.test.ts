import { describe, expect, it } from 'vitest';
import { backoffDelayMs, type BackoffPolicy } from '../../src/modules/queue/backoff.ts';

const policy: BackoffPolicy = { baseMs: 1_000, capMs: 60_000 };
const almostOne = () => 0.999_999;

/** Small deterministic PRNG (mulberry32) so the distribution test is repeatable. */
function seeded(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

describe('backoffDelayMs (full jitter)', () => {
  it('doubles the ceiling each attempt', () => {
    const ceilings = [1, 2, 3, 4, 5].map((n) => backoffDelayMs(n, policy, almostOne) + 1);
    expect(ceilings).toEqual([1_000, 2_000, 4_000, 8_000, 16_000]);
  });

  it('never exceeds the cap, even for absurd attempt counts', () => {
    for (const attempt of [7, 10, 50, 1_000]) {
      expect(backoffDelayMs(attempt, policy, almostOne)).toBeLessThan(60_000);
    }
  });

  it('can be as short as zero', () => {
    expect(backoffDelayMs(5, policy, () => 0)).toBe(0);
  });

  it('spreads retries across the whole window', () => {
    const random = seeded(42);
    const samples = Array.from({ length: 2_000 }, () => backoffDelayMs(4, policy, random));
    expect(Math.min(...samples)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...samples)).toBeLessThan(8_000);
    // Roughly uniform: each quarter of the window gets a fair share.
    for (let q = 0; q < 4; q++) {
      const inQuarter = samples.filter((s) => s >= q * 2_000 && s < (q + 1) * 2_000).length;
      expect(inQuarter).toBeGreaterThan(400);
      expect(inQuarter).toBeLessThan(600);
    }
  });

  it('treats attempt 0 like attempt 1', () => {
    expect(backoffDelayMs(0, policy, almostOne)).toBe(backoffDelayMs(1, policy, almostOne));
  });
});
