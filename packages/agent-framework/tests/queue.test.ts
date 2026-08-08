import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { connectQueue, ensureStream, publishTask, consumeTasks, type TaskMessage } from '../src/queue';
import type { NatsConnection } from 'nats';

const NATS_URL = process.env.TEST_NATS_URL ?? 'nats://localhost:4222';

describe('queue', () => {
  let nc: NatsConnection;

  beforeAll(async () => {
    nc = await connectQueue(NATS_URL);
    await ensureStream(nc);
  });

  afterAll(async () => {
    await nc.close();
  });

  it('delivers a published task to a consumer and acks it', async () => {
    const received: TaskMessage[] = [];
    const stop = await consumeTasks(
      nc,
      async (msg) => {
        received.push(msg);
      },
      { role: 'test-happy', maxDeliver: 3, onFinalFailure: async () => {} },
    );

    await publishTask(nc, 'test-happy', { taskId: 't1', role: 'test-happy', payload: { hello: 'world' } });

    await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 3000 });
    expect(received[0].taskId).toBe('t1');

    await stop();
  });

  it('routes to onFinalFailure after max_deliver attempts when the handler always throws', async () => {
    const failures: TaskMessage[] = [];
    const stop = await consumeTasks(
      nc,
      async () => {
        throw new Error('boom');
      },
      {
        role: 'test-failing',
        maxDeliver: 2,
        onFinalFailure: async (msg) => {
          failures.push(msg);
        },
      },
    );

    await publishTask(nc, 'test-failing', { taskId: 't2', role: 'test-failing', payload: {} });

    await vi.waitFor(() => expect(failures).toHaveLength(1), { timeout: 5000 });
    expect(failures[0].taskId).toBe('t2');

    await stop();
  });

  it('stop() resolves in bounded time even when called immediately after starting, before the first consume() round trip necessarily resolves', async () => {
    const stop = await consumeTasks(
      nc,
      async () => {},
      { role: 'test-immediate-stop', maxDeliver: 3, onFinalFailure: async () => {} },
    );

    // Call stop() right away, without waiting for anything else — this races against the
    // background consume-loop's `await consumer.consume()` round trip. If stop() is called
    // before that round trip resolves, `activeMessages` is still undefined when stop() runs,
    // so `activeMessages?.close()` is a no-op. The consume loop must still detect the stop
    // request once its `consumer.consume()` resolves and close that iterator itself, rather
    // than entering `for await` and blocking forever. Race stop() against a short timeout to
    // prove it doesn't hang.
    const result = await Promise.race([
      stop().then(() => 'stopped' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 4000)),
    ]);

    expect(result).toBe('stopped');
  });

  it('logs an unexpected consumer-loop error instead of silently swallowing it', async () => {
    const role = 'test-malformed-payload';
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const stop = await consumeTasks(
        nc,
        async () => {},
        { role, maxDeliver: 3, onFinalFailure: async () => {} },
      );

      // Publish a malformed (non-JSON) payload directly to the role's subject, bypassing
      // publishTask's JSON.stringify. `JSON.parse(m.string())` in the consume loop is not
      // wrapped in the handler's try/catch, so this throws out of the `for await` and must
      // now be surfaced via console.error rather than disappearing into `run().catch(() => {})`.
      const js = nc.jetstream();
      await js.publish(`tasks.${role}`, 'not-valid-json{{{');

      await vi.waitFor(() => expect(errorSpy).toHaveBeenCalled(), { timeout: 3000 });

      const loggedArgs = errorSpy.mock.calls.flat();
      expect(
        loggedArgs.some(
          (arg) => arg instanceof SyntaxError || (typeof arg === 'string' && arg.includes(role)),
        ),
      ).toBe(true);

      await stop();
    } finally {
      errorSpy.mockRestore();
    }
  });
});
