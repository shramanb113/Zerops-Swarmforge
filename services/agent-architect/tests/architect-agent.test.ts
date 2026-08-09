import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import {
  createDb, connectQueue, ensureStream, publishTask, tasks, taskEvents, products, architectureProposals, eq, type Db,
} from '@swarmforge/agent-framework';
import type { NatsConnection } from 'nats';
import { ArchitectAgent } from '../src/architect-agent.js';
import { createMockModel } from '../../../packages/agent-framework/tests/support/mock-model.js';

const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://swarmforge:swarmforge@localhost:5432/swarmforge';
const NATS_URL = process.env.TEST_NATS_URL ?? 'nats://localhost:4222';
const REDIS_URL = process.env.TEST_VALKEY_URL ?? 'redis://localhost:6379';

const PROPOSED = {
  serviceName: 'Todo API',
  summary: 'A REST API for managing a todo list.',
  responsibilities: ['CRUD operations on todo items'],
  endpoints: [{ method: 'GET', path: '/todos' }],
  dataModel: { todo: { id: 'string', title: 'string', done: 'boolean' } },
};

describe('ArchitectAgent', () => {
  let db: Db;
  let nc: NatsConnection;
  let redis: Redis;
  let agent: ArchitectAgent;
  let postTasksSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    db = await createDb(DB_URL);
    nc = await connectQueue(NATS_URL);
    await ensureStream(nc);
    redis = new Redis(REDIS_URL);
    agent = new ArchitectAgent({
      db, redis, nc, instanceId: 'test-architect-1',
      model: createMockModel({ object: PROPOSED }),
    });
    postTasksSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: randomUUID(), status: 'pending' }), { status: 201 }),
    );
    await agent.start();
  });

  afterAll(async () => {
    await agent.stop();
    await redis.quit();
    await nc.close();
    postTasksSpy.mockRestore();
  });

  it('turns a product description into a product row and an architecture proposal, then hands off to coder', async () => {
    const taskId = randomUUID();
    await db.insert(tasks).values({
      id: taskId, type: 'build-product', role: 'architect', payload: { description: 'a todo app' }, status: 'pending',
    });
    await publishTask(nc, 'architect', { taskId, role: 'architect', payload: { description: 'a todo app' } });

    await vi.waitFor(
      async () => {
        const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
        expect(row?.status).toBe('done');
      },
      { timeout: 5000 },
    );

    const events = await db.select().from(taskEvents).where(eq(taskEvents.taskId, taskId));
    expect(events.map((e) => e.eventType)).toEqual(['task_started', 'task_completed']);

    const [proposal] = await db.select().from(architectureProposals).where(eq(architectureProposals.taskId, taskId));
    expect(proposal?.serviceName).toBe('todo-api');

    const [product] = await db.select().from(products).where(eq(products.id, proposal!.productId));
    expect(product?.status).toBe('proposed');
    expect(product?.name).toBe('todo-api');

    expect(postTasksSpy).toHaveBeenCalledWith(
      expect.stringContaining('/tasks'),
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"role":"coder"'),
      }),
    );
  });

  it('is idempotent under redelivery: the same taskId never produces a second product/proposal pair', async () => {
    const taskId = randomUUID();
    await db.insert(tasks).values({
      id: taskId, type: 'build-product', role: 'architect', payload: { description: 'a todo app' }, status: 'pending',
    });

    // Publish the same taskId twice, simulating NATS redelivering the same task after a
    // transient failure — the second onTask run should reuse the first run's rows rather
    // than generating and inserting a duplicate product/proposal pair.
    await publishTask(nc, 'architect', { taskId, role: 'architect', payload: { description: 'a todo app' } });
    await vi.waitFor(async () => {
      const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
      expect(row?.status).toBe('done');
    }, { timeout: 5000 });

    const [firstProposal] = await db.select().from(architectureProposals).where(eq(architectureProposals.taskId, taskId));
    expect(firstProposal).toBeDefined();

    await db.update(tasks).set({ status: 'pending' }).where(eq(tasks.id, taskId));
    await publishTask(nc, 'architect', { taskId, role: 'architect', payload: { description: 'a todo app' } });
    await vi.waitFor(async () => {
      const events = await db.select().from(taskEvents).where(eq(taskEvents.taskId, taskId));
      expect(events.filter((e) => e.eventType === 'task_completed').length).toBe(2);
    }, { timeout: 5000 });

    const proposalRows = await db.select().from(architectureProposals).where(eq(architectureProposals.taskId, taskId));
    expect(proposalRows).toHaveLength(1);
    expect(proposalRows[0]?.id).toBe(firstProposal!.id);

    const productRows = await db.select().from(products).where(eq(products.id, firstProposal!.productId));
    expect(productRows).toHaveLength(1);
  });
});
