import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Redis from 'ioredis';
import {
  createDb, connectQueue, ensureStream, publishTask, tasks, taskEvents, products, architectureProposals, eq, type Db,
} from '@swarmforge/agent-framework';
import type { NatsConnection } from 'nats';
import { CoderAgent } from '../src/coder-agent.js';
import { createMockModel } from '../../../packages/agent-framework/tests/support/mock-model.js';

const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://swarmforge:swarmforge@localhost:5432/swarmforge';
const NATS_URL = process.env.TEST_NATS_URL ?? 'nats://localhost:4222';
const REDIS_URL = process.env.TEST_VALKEY_URL ?? 'redis://localhost:6379';
// `process.cwd()` varies by invocation (a service's own directory when run via `pnpm --filter
// X dev`, but the repo root when the same code runs inside vitest via the root `test` script) -
// resolving relative to import.meta.url is stable regardless of how/where the process started.
const PRODUCTS_ROOT = fileURLToPath(new URL('../../../products', import.meta.url));

describe('CoderAgent', () => {
  let db: Db;
  let nc: NatsConnection;
  let redis: Redis;
  let agent: CoderAgent;
  let productId: string;

  beforeAll(async () => {
    db = await createDb(DB_URL);
    nc = await connectQueue(NATS_URL);
    await ensureStream(nc);
    // A durable consumer and any un-acked messages on its subject outlive the vitest process
    // (both live in the broker, not this process). deliver_policy is 'All', so a freshly
    // recreated 'coder-consumer' replays every message ever published to tasks.coder across every
    // earlier local run - each carrying a stale productId whose product dir this run's afterAll
    // already deleted, and each competing for the one scripted tool call the mock model below
    // only fires once (see mock-model.ts's `callCount === 1` gate). Without this reset, only
    // whichever backlog message happens to be replayed first gets real code written; every other
    // delivery - including this test's own - degrades to a no-op "done" text response and fails
    // compileCheck. See swarmforge-foundation-carryforward memory item 6; same pattern as
    // `resetRole` in packages/agent-framework/tests/queue.test.ts.
    await resetRole(nc, 'coder');
    redis = new Redis(REDIS_URL);

    productId = randomUUID();
    await db.insert(products).values({ id: productId, name: 'hello-api', description: 'says hello', status: 'proposed' });
    await db.insert(architectureProposals).values({
      id: randomUUID(),
      productId,
      serviceName: 'hello-api',
      summary: 'Responds with a greeting.',
      endpoints: [{ method: 'GET', path: '/hello' }],
      dataModel: {},
    });

    agent = new CoderAgent({
      db, redis, nc, instanceId: 'test-coder-1',
      model: createMockModel({
        toolCalls: [{
          toolName: 'write_file',
          input: {
            // Deliberately the *wrong* path the real model actually produced live: the tool
            // contract is "relative to src/", but a model told the project lives in src/ will
            // sometimes prefix it anyway, which used to land the file at src/src/index.ts.
            path: 'src/index.ts',
            content:
              "import Fastify from 'fastify';\n" +
              "const app = Fastify();\n" +
              "app.get('/hello', async () => ({ message: 'hello' }));\n" +
              "app.listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' });\n",
          },
        }],
      }),
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: randomUUID(), status: 'pending' }), { status: 201 }),
    );
    await agent.start();
  });

  afterAll(async () => {
    await agent.stop();
    await redis.quit();
    await nc.close();
    vi.restoreAllMocks();
    await rm(path.join(PRODUCTS_ROOT, productId), { recursive: true, force: true });
    // Longer than the default 15s hookTimeout (vitest.config.ts): `agent.stop()` waits for the
    // in-flight compile-check task (a real `pnpm install`/`tsc` round-trip, see below) to finish
    // before the consumer stops, so this hook can't resolve any faster than that task does.
  }, 60000);

  it('scaffolds the product directory and writes generated source', async () => {
    const taskId = randomUUID();
    const payload = { productId, proposalId: randomUUID() };
    await db.insert(tasks).values({ id: taskId, type: 'build-product', role: 'coder', payload, status: 'pending' });
    await publishTask(nc, 'coder', { taskId, role: 'coder', payload });

    await vi.waitFor(
      async () => {
        const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
        expect(['done', 'failed']).toContain(row?.status);
      },
      // Measured on this machine: a cold `pnpm install --ignore-workspace && npx tsc --noEmit`
      // against a freshly scaffolded products/<id>/ alone takes ~19s (real npm registry
      // round-trip plus Windows npx/process-spawn overhead), before the rest of the task
      // pipeline (Mastra agent.generate() against the mock model, Postgres/Memory setup, task
      // bookkeeping) runs on top. The brief's original 20000ms budget assumed a faster
      // environment; 45000ms leaves real headroom instead of a timeout that's already spent by
      // the time compileCheck alone returns.
      { timeout: 45000 },
    );

    expect(existsSync(path.join(PRODUCTS_ROOT, productId, 'package.json'))).toBe(true);
    expect(existsSync(path.join(PRODUCTS_ROOT, productId, 'src', 'index.ts'))).toBe(true);
    // The redundant "src/" prefix the model supplied must be stripped, not resolved a second
    // time against srcRoot - both files existed on disk before this was fixed.
    expect(existsSync(path.join(PRODUCTS_ROOT, productId, 'src', 'src', 'index.ts'))).toBe(false);

    const events = await db.select().from(taskEvents).where(eq(taskEvents.taskId, taskId));
    expect(events.some((e) => e.eventType === 'task_started')).toBe(true);
    const codeGenerated = events.find((e) => e.eventType === 'code_generated');
    const files = (codeGenerated?.payload as { files: Array<{ path: string; content: string }> } | undefined)?.files;
    // The *resolved* path relative to src/, not the raw string the model sent.
    expect(files?.map((f) => f.path)).toEqual(['index.ts']);
    // Content is captured verbatim from what was actually written, not re-read from disk.
    expect(files?.[0]?.content).toContain("app.get('/hello'");
    // Longer than the default 15s testTimeout (vitest.config.ts) and matching the vi.waitFor
    // budget above - the compile-check step does a real `pnpm install`/`tsc --noEmit` network
    // round-trip against products/<id>/, which the 15s default doesn't leave room for on top of
    // the rest of the task pipeline.
  }, 60000);
});

/**
 * Clears all JetStream state for one role: drops its durable consumer (resetting delivery
 * counts) and purges any messages still sitting on its subject. Both outlive the test process -
 * a durable and its un-acked/backlogged messages survive in the broker - so without this, a
 * message left over from an earlier local run comes back as a spurious redelivery. Same helper
 * as `resetRole` in packages/agent-framework/tests/queue.test.ts, duplicated here rather than
 * exported from agent-framework since it's test-only plumbing, not part of the package's API.
 */
async function resetRole(nc: NatsConnection, role: string): Promise<void> {
  const jsm = await nc.jetstreamManager();
  try {
    await jsm.consumers.delete('TASKS', `${role}-consumer`);
  } catch {
    // no durable left over from a previous run - nothing to drop
  }
  await jsm.streams.purge('TASKS', { filter: `tasks.${role}` });
}
