import { describe, expect, it } from 'vitest';
import { Waker } from '../../src/modules/queue/waker.ts';

describe('Waker', () => {
  it('sleeps until the deadline when nobody notifies', async () => {
    const waker = new Waker();
    const started = performance.now();
    await waker.sleep(30);
    expect(performance.now() - started).toBeGreaterThanOrEqual(25);
  });

  it('wakes early on notify', async () => {
    const waker = new Waker();
    const started = performance.now();
    setTimeout(() => {
      waker.notify();
    }, 10);
    await waker.sleep(10_000);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it('remembers a notify that arrives before sleep', async () => {
    const waker = new Waker();
    waker.notify();
    const started = performance.now();
    await waker.sleep(10_000);
    expect(performance.now() - started).toBeLessThan(100);
  });
});
