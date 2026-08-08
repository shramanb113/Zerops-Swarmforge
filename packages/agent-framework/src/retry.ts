export interface RetryOptions {
  retries: number;
  minDelayMs: number;
  maxDelayMs: number;
}

const DEFAULT_OPTIONS: RetryOptions = { retries: 5, minDelayMs: 200, maxDelayMs: 5000 };

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = DEFAULT_OPTIONS): Promise<T> {
  let attempt = 0;
  let lastError: unknown;
  while (attempt <= opts.retries) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      attempt++;
      if (attempt > opts.retries) break;
      const delay = Math.min(opts.minDelayMs * 2 ** (attempt - 1), opts.maxDelayMs);
      await sleep(delay);
    }
  }
  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
