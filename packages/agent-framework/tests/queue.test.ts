import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { connectQueue, ensureStream, publishTask, consumeTasks, type TaskMessage } from '../src/queue';
import { AckPolicy, DeliverPolicy, type NatsConnection } from 'nats';

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

  it('logs a malformed payload instead of silently swallowing it', async () => {
    const role = 'test-malformed-payload';
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const stop = await consumeTasks(
        nc,
        async () => {},
        { role, maxDeliver: 3, onFinalFailure: async () => {} },
      );

      // Publish a malformed (non-JSON) payload directly to the role's subject, bypassing
      // publishTask's JSON.stringify, so `JSON.parse(m.string())` in the consume loop throws.
      // That failure must be surfaced via console.error rather than disappearing silently.
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

  it('keeps consuming after a malformed payload — the poison message does not kill the loop', async () => {
    const role = 'test-malformed-then-good';
    const received: TaskMessage[] = [];
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Exactly one well-formed message must reach the handler, so a message left pending by a
    // previous run must not be redelivered into this one — see resetRole.
    await resetRole(nc, role);

    try {
      const stop = await consumeTasks(
        nc,
        async (msg) => {
          received.push(msg);
        },
        { role, maxDeliver: 3, onFinalFailure: async () => {} },
      );

      // A malformed payload used to throw out of the `for await`, unwinding run() and leaving
      // this role's consumer permanently dead. It must now term() just that one message.
      const js = nc.jetstream();
      await js.publish(`tasks.${role}`, 'not-valid-json{{{');
      await vi.waitFor(() => expect(errorSpy).toHaveBeenCalled(), { timeout: 3000 });

      // The consumer must still be alive: a well-formed message published after the bad one
      // still reaches the handler.
      await publishTask(nc, role, { taskId: 'after-poison', role, payload: { ok: true } });

      await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 5000 });
      expect(received[0].taskId).toBe('after-poison');

      await stop();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('naks with a positive backoff delay rather than redelivering immediately', async () => {
    const role = 'test-nak-backoff';

    // The backoff is derived from deliveryCount, so this test is only deterministic against a
    // clean slate — see resetRole.
    await resetRole(nc, role);

    // The consume loop owns the JsMsg objects it naks, so there is no handle on them from out
    // here. Grab the shared JsMsgImpl prototype off a throwaway probe message instead and spy
    // on `nak` there — the same method every consumed message dispatches through.
    const nakTarget = await captureJsMsgPrototype(nc);
    const nakSpy = vi.spyOn(nakTarget, 'nak');

    try {
      const stop = await consumeTasks(
        nc,
        async () => {
          throw new Error('transient');
        },
        {
          // maxDeliver high enough that the first failure takes the nak() branch rather than
          // the onFinalFailure/term() branch.
          role,
          maxDeliver: 5,
          onFinalFailure: async () => {},
        },
      );

      await publishTask(nc, role, { taskId: 'nak-1', role, payload: {} });

      await vi.waitFor(() => expect(nakSpy).toHaveBeenCalled(), { timeout: 5000 });

      // A bare nak() redelivers immediately, burning every maxDeliver attempt in milliseconds.
      // The delay must be a real positive number: 1000 * 2^(deliveryCount - 1) => 1000ms on
      // the first delivery.
      const [delay] = nakSpy.mock.calls[0];
      expect(typeof delay).toBe('number');
      expect(delay as number).toBeGreaterThan(0);
      expect(delay).toBe(1000);

      await stop();
    } finally {
      nakSpy.mockRestore();
    }
  });
});

/**
 * Clears all JetStream state for one role: drops its durable consumer (resetting delivery
 * counts) and purges any messages still sitting on its subject. Both outlive the test process —
 * a durable and its un-acked messages survive in the broker — so without this, a message left
 * pending by an earlier run comes back as a redelivery and shifts both `deliveryCount` and the
 * number of messages a handler observes.
 */
async function resetRole(nc: NatsConnection, role: string): Promise<void> {
  const jsm = await nc.jetstreamManager();
  try {
    await jsm.consumers.delete('TASKS', `${role}-consumer`);
  } catch {
    // no durable left over from a previous run — nothing to drop
  }
  await jsm.streams.purge('TASKS', { filter: `tasks.${role}` });
}

/**
 * Delivers one throwaway message through a scratch durable consumer purely to get hold of a
 * live JsMsg, and returns its prototype (nats' internal `JsMsgImpl.prototype`). Spying on that
 * object intercepts ack/nak/term for every message the library subsequently hands out, which is
 * the only way to observe what the consume loop passes to `nak()`.
 */
async function captureJsMsgPrototype(nc: NatsConnection): Promise<{ nak: (millis?: number) => void }> {
  const role = 'test-jsmsg-probe';
  const durableName = `${role}-consumer`;
  const jsm = await nc.jetstreamManager();
  try {
    await jsm.consumers.info('TASKS', durableName);
  } catch {
    await jsm.consumers.add('TASKS', {
      durable_name: durableName,
      filter_subject: `tasks.${role}`,
      ack_policy: AckPolicy.Explicit,
      deliver_policy: DeliverPolicy.All,
    });
  }

  await publishTask(nc, role, { taskId: 'probe', role, payload: {} });

  const consumer = await nc.jetstream().consumers.get('TASKS', durableName);
  const msg = await consumer.next({ expires: 5000 });
  if (!msg) throw new Error('probe message was never delivered — cannot capture JsMsg prototype');
  msg.ack();

  return Object.getPrototypeOf(msg) as { nak: (millis?: number) => void };
}
