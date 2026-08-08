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
});
