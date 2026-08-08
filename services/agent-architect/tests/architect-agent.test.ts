import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import Redis from 'ioredis';
import { createDb, connectQueue, ensureStream, publishTask, tasks, taskEvents, type Db } from '@swarmforge/agent-framework';
import type { NatsConnection } from 'nats';
import { ArchitectAgent } from '../src/architect-agent';

const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://swarmforge:swarmforge@localhost:5432/swarmforge';
const NATS_URL = process.env.TEST_NATS_URL ?? 'nats://localhost:4222';
const REDIS_URL = process.env.TEST_VALKEY_URL ?? 'redis://localhost:6379';

describe('ArchitectAgent', () => {
  let db: Db;
  let nc: NatsConnection;
  let redis: Redis;
  let agent: ArchitectAgent;

  beforeAll(async () => {
    db = await createDb(DB_URL);
    nc = await connectQueue(NATS_URL);
    await ensureStream(nc);
    redis = new Redis(REDIS_URL);
    agent = new ArchitectAgent({ db, redis, nc, instanceId: 'test-architect-1' });
    await agent.start();
  });

  afterAll(async () => {
    await agent.stop();
    await redis.quit();
    await nc.close();
  });

  it('processes a task published on tasks.architect and logs events under role architect', async () => {
    const taskId = randomUUID();
    await db.insert(tasks).values({ id: taskId, type: 'design', role: 'architect', payload: {}, status: 'pending' });
    await publishTask(nc, 'architect', { taskId, role: 'architect', payload: {} });

    await vi.waitFor(
      async () => {
        const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
        expect(row?.status).toBe('done');
      },
      { timeout: 5000 },
    );

    const events = await db.select().from(taskEvents).where(eq(taskEvents.taskId, taskId));
    expect(events.every((e) => e.role === 'architect')).toBe(true);
    expect(events.map((e) => e.eventType)).toEqual(['task_started', 'task_completed']);
  });
});
