import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Redis from 'ioredis';
import { createDb, connectQueue, ensureStream, consumeTasks, type Db } from '@swarmforge/agent-framework';
import type { NatsConnection } from 'nats';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server';

const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://swarmforge:swarmforge@localhost:5432/swarmforge';
const NATS_URL = process.env.TEST_NATS_URL ?? 'nats://localhost:4222';
const REDIS_URL = process.env.TEST_VALKEY_URL ?? 'redis://localhost:6379';

describe('control-plane server', () => {
  let app: FastifyInstance;
  let db: Db;
  let nc: NatsConnection;
  let redis: Redis;

  beforeAll(async () => {
    db = await createDb(DB_URL);
    nc = await connectQueue(NATS_URL);
    await ensureStream(nc);
    redis = new Redis(REDIS_URL);
    app = buildServer({ db, nc, redis });
  });

  afterAll(async () => {
    await app.close();
    await nc.close();
    await redis.quit();
  });

  it('POST /tasks inserts a row, publishes to the queue, and shows up in /world-state', async () => {
    const received: unknown[] = [];
    await consumeTasks(nc, async (msg) => { received.push(msg); }, {
      role: 'test-route',
      maxDeliver: 3,
      onFinalFailure: async () => {},
    });

    const response = await app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { type: 'test', role: 'test-route', payload: { a: 1 } },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json() as { id: string; status: string };
    expect(body.status).toBe('pending');

    await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 3000 });

    const worldState = await app.inject({ method: 'GET', url: '/world-state' });
    const worldBody = worldState.json() as { tasks: Array<{ id: string }> };
    expect(worldBody.tasks.some((t) => t.id === body.id)).toBe(true);
  });

  it('GET /presence returns current presence entries', async () => {
    await redis.set(
      'presence:test-role:instance-x',
      JSON.stringify({ role: 'test-role', instanceId: 'instance-x', startedAt: new Date().toISOString() }),
      'EX',
      10,
    );

    const response = await app.inject({ method: 'GET', url: '/presence' });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { agents: Array<{ instanceId: string }> };
    expect(body.agents.some((a) => a.instanceId === 'instance-x')).toBe(true);
  });
});
