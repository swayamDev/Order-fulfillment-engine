export interface BackoffPolicy {
  /** Ceiling of the first retry's delay. */
  readonly baseMs: number;
  /** No retry waits longer than this. */
  readonly capMs: number;
}

export const DEFAULT_BACKOFF: BackoffPolicy = { baseMs: 1_000, capMs: 5 * 60_000 };

/**
 * "Full jitter" exponential backoff: a uniformly random delay between zero and
 * min(cap, base * 2^(attempt - 1)). Spreading retries over the whole window
 * stops a burst of failures (say, the courier going down) from turning into a
 * synchronised burst of retries when it comes back.
 *
 * @param attempt the attempt that just failed, starting at 1
 */
export function backoffDelayMs(
  attempt: number,
  policy: BackoffPolicy = DEFAULT_BACKOFF,
  random: () => number = Math.random,
): number {
  const exponent = Math.max(0, attempt - 1);
  // Clamp the exponent so 2 ** n never overflows into Infinity.
  const ceiling = Math.min(policy.capMs, policy.baseMs * 2 ** Math.min(exponent, 30));
  return Math.floor(random() * ceiling);
}
