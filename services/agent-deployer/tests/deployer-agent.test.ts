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
      db, redis, nc, instanceId: 'test-deployer-1',
      model: createMockModel({
        toolCalls: [
          { toolName: 'write_deploy_config', input: { hostname: 'hello-api' } },
          { toolName: 'run_zcli', input: { command: 'service-import', args: ['zerops-service-import.yaml'] } },
          { toolName: 'run_zcli', input: { command: 'push', args: ['hello-api'] } },
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

    // The recorded commands must be real zcli invocations, with write_deploy_config first (the
    // step that actually writes zerops.yaml/zerops-service-import.yaml, which the two zcli
    // commands below depend on existing). `service-import` is nested under `project`; `push` is
    // top-level. Blanket-prefixing every command with 'project' used to record
    // `zcli project push hello-api`, which is not a command zcli has.
    const commands = (deployEvent?.payload as { commands: string[] }).commands;
    expect(commands).toEqual([
      'write_deploy_config',
      'zcli project service-import zerops-service-import.yaml',
      'zcli push hello-api',
    ]);
  });
});

describe('DeployerAgent sequence retry', () => {
  let db: Db;
  let nc: NatsConnection;
  let redis: Redis;
  let agent: DeployerAgent;
  let productId: string;

  beforeAll(async () => {
    db = await createDb(DB_URL);
    nc = await connectQueue(NATS_URL);
    await ensureStream(nc);
    await resetRole(nc, 'deployer');
    redis = new Redis(REDIS_URL);

    productId = randomUUID();
    await db.insert(products).values({ id: productId, name: 'retry-deploy-api', description: 'says hello', status: 'coding' });
    await mkdir(path.join(PRODUCTS_ROOT, productId), { recursive: true });

    agent = new DeployerAgent({
      db, redis, nc, instanceId: 'test-deployer-retry',
      model: createMockModel({
        rounds: [
          {
            // Wrong order: write_deploy_config is correct, but the two zcli calls are reversed
            // (push before service-import).
            toolCalls: [
              { toolName: 'write_deploy_config', input: { hostname: 'retry-deploy-api' } },
              { toolName: 'run_zcli', input: { command: 'push', args: ['retry-deploy-api'] } },
              { toolName: 'run_zcli', input: { command: 'service-import', args: ['zerops-service-import.yaml'] } },
            ],
          },
          {
            // Corrected: `commands` was cleared before this retry, so all three calls (including
            // write_deploy_config) must be repeated in the right order for the check to pass.
            toolCalls: [
              { toolName: 'write_deploy_config', input: { hostname: 'retry-deploy-api' } },
              { toolName: 'run_zcli', input: { command: 'service-import', args: ['zerops-service-import.yaml'] } },
              { toolName: 'run_zcli', input: { command: 'push', args: ['retry-deploy-api'] } },
            ],
          },
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

  it('retries once on a wrong tool-call sequence and succeeds on the corrected order', async () => {
    const taskId = randomUUID();
    const payload = { productId };
    await db.insert(tasks).values({ id: taskId, type: 'build-product', role: 'deployer', payload, status: 'pending' });
    await publishTask(nc, 'deployer', { taskId, role: 'deployer', payload });

    await vi.waitFor(async () => {
      const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
      expect(row?.status).toBe('done');
    }, { timeout: 15000 });

    const [product] = await db.select().from(products).where(eq(products.id, productId));
    expect(product?.status).toBe('deployed');

    const events = await db.select().from(taskEvents).where(eq(taskEvents.taskId, taskId));
    expect(events.some((e) => e.eventType === 'deploy_sequence_invalid')).toBe(false);

    const deployEvent = events.find((e) => e.eventType === 'deploy_recorded');
    expect((deployEvent?.payload as { attempts: number }).attempts).toBe(2);
    const commands = (deployEvent?.payload as { commands: string[] }).commands;
    expect(commands).toEqual([
      'write_deploy_config',
      'zcli project service-import zerops-service-import.yaml',
      'zcli push retry-deploy-api',
    ]);
  }, 20000);
});

describe('DeployerAgent sequence failure after retry', () => {
  let db: Db;
  let nc: NatsConnection;
  let redis: Redis;
  let agent: DeployerAgent;
  let productId: string;

  beforeAll(async () => {
    db = await createDb(DB_URL);
    nc = await connectQueue(NATS_URL);
    await ensureStream(nc);
    await resetRole(nc, 'deployer');
    redis = new Redis(REDIS_URL);

    productId = randomUUID();
    await db.insert(products).values({ id: productId, name: 'retry-deploy-fail-api', description: 'says hello', status: 'coding' });
    await mkdir(path.join(PRODUCTS_ROOT, productId), { recursive: true });

    agent = new DeployerAgent({
      db, redis, nc, instanceId: 'test-deployer-fail',
      // The mock model's script is finite (exactly the 2 rounds this test needs for the
      // in-process retry loop under test). Without capping maxDeliver at 1, a genuine final
      // failure here still naks (deliveryCount 1 < the framework's default maxDeliver of 5) and
      // NATS redelivers the whole task - which calls onTask again against a mock model that has
      // already exhausted every scripted round (it keeps repeating its last, text-only step, so
      // `commands` stays empty and the sequence check keeps failing "correctly" but for the
      // wrong reason) - a NATS-redelivery/exhausted-mock interaction orthogonal to what this
      // test verifies (the local retry-loop's own control flow), and confirmed empirically: left
      // uncapped, this task took 5 deliveries and ~16s, writing 5 duplicate `deploy_sequence_
      // invalid` events, before finally landing on `failed`. Same fix as CoderAgent's analogous
      // "failure after retry" test (services/agent-coder/tests/coder-agent.test.ts).
      maxDeliver: 1,
      model: createMockModel({
        rounds: [
          // Missing both run_zcli calls entirely.
          { toolCalls: [{ toolName: 'write_deploy_config', input: { hostname: 'retry-deploy-fail-api' } }] },
          // Still wrong: only `push`, missing both `write_deploy_config` and `service-import`
          // (`commands` was cleared before this retry, so write_deploy_config from round 1 no
          // longer counts).
          { toolCalls: [{ toolName: 'run_zcli', input: { command: 'push', args: ['retry-deploy-fail-api'] } }] },
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

  it('fails the task when the tool-call sequence is still wrong after one retry', async () => {
    const taskId = randomUUID();
    const payload = { productId };
    await db.insert(tasks).values({ id: taskId, type: 'build-product', role: 'deployer', payload, status: 'pending' });
    await publishTask(nc, 'deployer', { taskId, role: 'deployer', payload });

    await vi.waitFor(async () => {
      const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
      expect(row?.status).toBe('failed');
    }, { timeout: 15000 });

    const [product] = await db.select().from(products).where(eq(products.id, productId));
    expect(product?.status).toBe('failed');

    const events = await db.select().from(taskEvents).where(eq(taskEvents.taskId, taskId));
    expect(events.some((e) => e.eventType === 'deploy_recorded')).toBe(false);

    const invalidEvent = events.find((e) => e.eventType === 'deploy_sequence_invalid');
    expect(invalidEvent).toBeDefined();
    expect((invalidEvent?.payload as { attempts: unknown[] }).attempts).toHaveLength(2);
  }, 20000);
});

describe('DeployerAgent deploy_sequence_invalid idempotency guard', () => {
  let db: Db;
  let nc: NatsConnection;
  let redis: Redis;
  let agent: DeployerAgent;
  let productId: string;

  beforeAll(async () => {
    db = await createDb(DB_URL);
    nc = await connectQueue(NATS_URL);
    await ensureStream(nc);
    await resetRole(nc, 'deployer');
    redis = new Redis(REDIS_URL);

    productId = randomUUID();
    await db.insert(products).values({ id: productId, name: 'guard-deploy-fail-api', description: 'says hello', status: 'coding' });
    await mkdir(path.join(PRODUCTS_ROOT, productId), { recursive: true });

    agent = new DeployerAgent({
      db, redis, nc, instanceId: 'test-deployer-guard',
      // A genuine redelivery of a task whose final verdict was already `deploy_sequence_invalid`
      // must never reach the model at all - if the guard is broken, this mock would happily make
      // the correct three tool calls and the task would spuriously succeed instead of staying
      // failed, which is exactly the bug this guard exists to prevent.
      model: createMockModel({
        toolCalls: [
          { toolName: 'write_deploy_config', input: { hostname: 'guard-deploy-fail-api' } },
          { toolName: 'run_zcli', input: { command: 'service-import', args: ['zerops-service-import.yaml'] } },
          { toolName: 'run_zcli', input: { command: 'push', args: ['guard-deploy-fail-api'] } },
        ],
      }),
      // Isolates this test to a single delivery attempt, same rationale as "DeployerAgent
      // sequence failure after retry" above: without this, NATS would redeliver up to the
      // default maxDeliver (5) with exponential backoff before landing on `failed`, which the
      // guard itself already makes redundant (every redelivery would throw immediately) but
      // which would still slow this test down to no purpose.
      maxDeliver: 1,
    });
    await agent.start();
  });

  afterAll(async () => {
    await agent.stop();
    await redis.quit();
    await nc.close();
    await rm(path.join(PRODUCTS_ROOT, productId), { recursive: true, force: true });
  });

  it('re-throws immediately on a task that already has a deploy_sequence_invalid event, without retrying', async () => {
    const taskId = randomUUID();
    const payload = { productId };
    await db.insert(tasks).values({ id: taskId, type: 'build-product', role: 'deployer', payload, status: 'pending' });
    // Simulates a redelivery of a task whose in-onTask retry loop already exhausted both
    // tool-call attempts on a prior delivery: that delivery would have recorded exactly this
    // event before throwing. We insert it directly rather than driving a real failing sequence
    // through the pipeline (which "DeployerAgent sequence failure after retry" above already
    // covers) - this test only needs to prove that a *second* onTask call, seeing this event
    // already on record, skips straight to re-throwing.
    await db.insert(taskEvents).values({
      taskId,
      role: 'deployer',
      eventType: 'deploy_sequence_invalid',
      payload: { attempts: [{ ok: false, commands: [] }, { ok: false, commands: [] }] },
    });
    await publishTask(nc, 'deployer', { taskId, role: 'deployer', payload });

    await vi.waitFor(async () => {
      const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
      expect(row?.status).toBe('failed');
    }, { timeout: 5000 });

    // zerops.yaml was never written - the agent never even attempted a new tool-call sequence.
    expect(existsSync(path.join(PRODUCTS_ROOT, productId, 'zerops.yaml'))).toBe(false);

    const events = await db.select().from(taskEvents).where(eq(taskEvents.taskId, taskId));
    // Exactly the one `deploy_sequence_invalid` event this test inserted itself - not a second,
    // duplicate one from a redone (and re-failed) retry loop.
    expect(events.filter((e) => e.eventType === 'deploy_sequence_invalid')).toHaveLength(1);
    expect(events.some((e) => e.eventType === 'deploy_recorded')).toBe(false);
  }, 10000);
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
