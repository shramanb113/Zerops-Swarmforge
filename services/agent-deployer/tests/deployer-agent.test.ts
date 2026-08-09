import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Redis from 'ioredis';
import {
  createDb, connectQueue, ensureStream, publishTask, tasks, taskEvents, products, eq, type Db,
} from '@swarmforge/agent-framework';
import type { NatsConnection } from 'nats';
import { DeployerAgent } from '../src/deployer-agent.js';
import { createMockModel } from '../../../packages/agent-framework/tests/support/mock-model.js';

const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://swarmforge:swarmforge@localhost:5432/swarmforge';
const NATS_URL = process.env.TEST_NATS_URL ?? 'nats://localhost:4222';
const REDIS_URL = process.env.TEST_VALKEY_URL ?? 'redis://localhost:6379';
// `process.cwd()` varies by invocation (a service's own directory when run via `pnpm --filter
// X dev`, but the repo root when the same code runs inside vitest via the root `test` script) -
// resolving relative to import.meta.url is stable regardless of how/where the process started.
const PRODUCTS_ROOT = fileURLToPath(new URL('../../../products', import.meta.url));

describe('DeployerAgent', () => {
  let db: Db;
  let nc: NatsConnection;
  let redis: Redis;
  let agent: DeployerAgent;
  let productId: string;

  beforeAll(async () => {
    db = await createDb(DB_URL);
    nc = await connectQueue(NATS_URL);
    await ensureStream(nc);
    // A durable consumer and any un-acked messages on its subject outlive the vitest process
    // (both live in the broker, not this process). deliver_policy is 'All', so a freshly
    // recreated 'deployer-consumer' replays every message ever published to tasks.deployer across
    // every earlier local run - each carrying a stale productId whose product dir this run's
    // afterAll already deleted, and each competing for the one scripted tool call the mock model
    // below only fires once (see mock-model.ts's `callCount === 1` gate). Without this reset,
    // only whichever backlog message happens to be replayed first gets the real tool calls; every
    // other delivery - including this test's own - degrades to a no-op "done" text response and
    // never writes zerops.yaml. See swarmforge-foundation-carryforward memory item 6; same
    // pattern as `resetRole` in packages/agent-framework/tests/queue.test.ts and
    // services/agent-coder/tests/coder-agent.test.ts.
    await resetRole(nc, 'deployer');
    redis = new Redis(REDIS_URL);

    productId = randomUUID();
    await db.insert(products).values({ id: productId, name: 'hello-api', description: 'says hello', status: 'coding' });
    await mkdir(path.join(PRODUCTS_ROOT, productId), { recursive: true });

    agent = new DeployerAgent({
      db, redis, nc, instanceId: 'test-deployer-1', databaseUrl: DB_URL,
      model: createMockModel({
        toolCalls: [
          { toolName: 'write_deploy_config', input: { hostname: 'hello-api' } },
          { toolName: 'run_zcli', input: { command: 'service-import', args: ['zerops-service-import.yaml'] } },
        ],
      }),
    });
    await agent.start();
  });

  afterAll(async () => {
    await agent.stop();
    await redis.quit();
    await nc.close();
    await rm(path.join(PRODUCTS_ROOT, productId), { recursive: true, force: true });
  });

  it('writes zerops.yaml and records a dry-run without executing zcli', async () => {
    const taskId = randomUUID();
    const payload = { productId };
    await db.insert(tasks).values({ id: taskId, type: 'build-product', role: 'deployer', payload, status: 'pending' });
    await publishTask(nc, 'deployer', { taskId, role: 'deployer', payload });

    await vi.waitFor(
      async () => {
        const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
        expect(row?.status).toBe('done');
      },
      { timeout: 10000 },
    );

    expect(existsSync(path.join(PRODUCTS_ROOT, productId, 'zerops.yaml'))).toBe(true);

    const [product] = await db.select().from(products).where(eq(products.id, productId));
    expect(product?.status).toBe('deployed');

    const events = await db.select().from(taskEvents).where(eq(taskEvents.taskId, taskId));
    const deployEvent = events.find((e) => e.eventType === 'deploy_recorded');
    expect((deployEvent?.payload as { dryRun: boolean }).dryRun).toBe(true);
  });
});

/**
 * Clears all JetStream state for one role: drops its durable consumer (resetting delivery
 * counts) and purges any messages still sitting on its subject. Both outlive the test process -
 * a durable and its un-acked/backlogged messages survive in the broker - so without this, a
 * message left over from an earlier local run comes back as a spurious redelivery. Same helper
 * as `resetRole` in packages/agent-framework/tests/queue.test.ts and
 * services/agent-coder/tests/coder-agent.test.ts, duplicated here rather than exported from
 * agent-framework since it's test-only plumbing, not part of the package's API.
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
