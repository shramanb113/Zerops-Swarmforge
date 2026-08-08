import { describe, it, expect, vi } from 'vitest';
import { withRetry } from '../src/retry';

describe('withRetry', () => {
  it('retries until success and returns the result', async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls < 3) throw new Error('flaky');
      return 'ok';
    });

    const result = await withRetry(fn, { retries: 5, minDelayMs: 1, maxDelayMs: 5 });

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('throws the last error once retries are exhausted', async () => {
    const fn = vi.fn(async () => {
      throw new Error('always fails');
    });

    await expect(withRetry(fn, { retries: 2, minDelayMs: 1, maxDelayMs: 5 })).rejects.toThrow('always fails');
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
