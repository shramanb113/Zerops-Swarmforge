import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import Redis from 'ioredis';
import { connectQueue, ensureStream, publishTask } from '../src/queue';
import { createDb, type Db } from '../src/db/client';
import { tasks, taskEvents } from '../src/db/schema';
import { ZeropsAgent } from '../src/agent';
import type { NatsConnection } from 'nats';

const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://swarmforge:swarmforge@localhost:5432/swarmforge';
const NATS_URL = process.env.TEST_NATS_URL ?? 'nats://localhost:4222';
const REDIS_URL = process.env.TEST_VALKEY_URL ?? 'redis://localhost:6379';

class TestAgent extends ZeropsAgent {
  public calls: unknown[] = [];
  async onTask(payload: unknown): Promise<void> {
    this.calls.push(payload);
  }
}

describe('ZeropsAgent', () => {
  let db: Db;
  let redis: Redis;
  let nc: NatsConnection;
  let agent: TestAgent;

  beforeAll(async () => {
    db = await createDb(DB_URL);
    redis = new Redis(REDIS_URL);
    nc = await connectQueue(NATS_URL);
    await ensureStream(nc);
    agent = new TestAgent({ db, redis, nc, role: 'test-agent', instanceId: 'test-1' });
    await agent.start();
  });

  afterAll(async () => {
    await agent.stop();
    await redis.quit();
    await nc.close();
  });

  it('processes a task end to end and records the event sequence', async () => {
    const taskId = randomUUID();
    await db.insert(tasks).values({ id: taskId, type: 'test', role: 'test-agent', payload: { hi: true }, status: 'pending' });

    await publishTask(nc, 'test-agent', { taskId, role: 'test-agent', payload: { hi: true } });

    await vi.waitFor(
      async () => {
        const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
        expect(row?.status).toBe('done');
      },
      { timeout: 5000 },
    );

    const events = await db.select().from(taskEvents).where(eq(taskEvents.taskId, taskId));
    expect(events.map((e) => e.eventType)).toEqual(['task_started', 'task_completed']);
    expect(agent.calls).toEqual([{ hi: true }]);
  });
});
