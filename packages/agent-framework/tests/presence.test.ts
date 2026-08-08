import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Redis from 'ioredis';
import { PresenceHeartbeat, listPresence } from '../src/presence';

const REDIS_URL = process.env.TEST_VALKEY_URL ?? 'redis://localhost:6379';

describe('PresenceHeartbeat', () => {
  let redis: Redis;

  beforeAll(() => {
    redis = new Redis(REDIS_URL);
  });

  afterAll(async () => {
    await redis.quit();
  });

  it('writes a presence key that shows up in listPresence with a bounded TTL', async () => {
    const heartbeat = new PresenceHeartbeat(redis, 'architect', 'test-instance-1');
    await heartbeat.beat();

    const entries = await listPresence(redis);
    const mine = entries.find((e) => e.instanceId === 'test-instance-1');

    expect(mine).toBeDefined();
    expect(mine?.role).toBe('architect');

    const ttl = await redis.ttl('presence:architect:test-instance-1');
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(10);
  });

  it('clears prior timer when start() is called twice (prevents orphaned interval)', () => {
    const heartbeat = new PresenceHeartbeat(redis, 'architect', 'test-instance-2');
    const setIntervalSpy = vi.spyOn(global, 'setInterval');
    const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

    // Call start() twice
    heartbeat.start();
    const callCount1 = setIntervalSpy.mock.calls.length;
    expect(callCount1).toBe(1);
    expect(clearIntervalSpy.mock.calls.length).toBe(0);

    heartbeat.start();
    const callCount2 = setIntervalSpy.mock.calls.length;
    expect(callCount2).toBe(2); // Should have called setInterval again
    expect(clearIntervalSpy.mock.calls.length).toBe(1); // Should have cleared the first interval

    // Verify stop() works after double-start
    heartbeat.stop();
    expect(clearIntervalSpy.mock.calls.length).toBe(2); // Should have cleared the second interval

    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
  });
});
