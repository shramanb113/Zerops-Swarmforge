import { describe, it, expect, vi, beforeEach } from 'vitest';

const connect = vi.fn();
vi.mock('pg', () => ({
  Pool: vi.fn().mockImplementation(() => ({ connect })),
}));

import { createDb } from '../src/db/client';

describe('createDb', () => {
  beforeEach(() => {
    connect.mockReset();
  });

  it('retries the initial connection before succeeding', async () => {
    let attempts = 0;
    connect.mockImplementation(async () => {
      attempts++;
      if (attempts < 3) throw new Error('connection refused');
      return { release: vi.fn() };
    });

    const db = await createDb('postgres://test');

    expect(attempts).toBe(3);
    expect(db).toBeDefined();
  });

  it('throws once retries are exhausted', async () => {
    connect.mockImplementation(async () => {
      throw new Error('connection refused');
    });

    await expect(createDb('postgres://test')).rejects.toThrow('connection refused');
  });
});
