import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
});
