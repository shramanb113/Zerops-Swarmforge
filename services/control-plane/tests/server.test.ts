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

  it('POST /tasks with an invalid body returns 400 with sanitized issues, not a raw 500', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { type: '', role: '' },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json() as { error: string; issues: unknown };
    expect(body.error).toBe('Invalid request');
    expect(body.issues).toBeDefined();
    expect(response.payload).not.toContain('Internal Server Error');
  });

  it('POST /tasks with no payload field defaults it to {} rather than crashing on the NOT NULL column', async () => {
    // `payload: z.unknown()` made the key optional, so omitting it inserted SQL NULL into a
    // NOT NULL jsonb column — a raw Postgres 23502 leaked to the client as a 500.
    const response = await app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { type: 'test', role: 'test-no-payload' },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json() as { id: string; status: string };
    expect(body.status).toBe('pending');

    const worldState = await app.inject({ method: 'GET', url: '/world-state' });
    const worldBody = worldState.json() as { tasks: Array<{ id: string; payload: unknown }> };
    const created = worldBody.tasks.find((t) => t.id === body.id);
    expect(created?.payload).toEqual({});
  });

  it('POST /tasks rejects a role containing a dot, which would build an unroutable NATS subject', async () => {
    // publishTask interpolates role into `tasks.${role}`, and the TASKS stream only captures
    // the single-token `tasks.*`. A dotted role publishes to a subject nothing consumes, while
    // the task row has already been inserted — orphaning it as `pending` forever.
    const response = await app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { type: 'test', role: 'a.b', payload: {} },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json() as { error: string; issues: unknown };
    expect(body.error).toBe('Invalid request');
    expect(response.payload).not.toContain('Internal Server Error');
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
