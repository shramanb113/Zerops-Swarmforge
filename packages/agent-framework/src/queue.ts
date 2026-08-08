import { connect, AckPolicy, DeliverPolicy, type NatsConnection } from 'nats';
import { withRetry } from './retry.js';

const STREAM_NAME = 'TASKS';
const SUBJECT_PREFIX = 'tasks';

export interface TaskMessage {
  taskId: string;
  role: string;
  payload: unknown;
}

export async function connectQueue(servers: string, user?: string, pass?: string): Promise<NatsConnection> {
  return withRetry(() => connect({ servers, user, pass }));
}

export async function ensureStream(nc: NatsConnection): Promise<void> {
  const jsm = await nc.jetstreamManager();
  try {
    await jsm.streams.info(STREAM_NAME);
  } catch {
    await jsm.streams.add({ name: STREAM_NAME, subjects: [`${SUBJECT_PREFIX}.*`] });
  }
}

export async function publishTask(nc: NatsConnection, role: string, msg: TaskMessage): Promise<void> {
  const js = nc.jetstream();
  await js.publish(`${SUBJECT_PREFIX}.${role}`, JSON.stringify(msg));
}

export type TaskHandler = (msg: TaskMessage) => Promise<void>;

export interface ConsumeOptions {
  role: string;
  maxDeliver: number;
  onFinalFailure: (msg: TaskMessage, err: unknown) => Promise<void>;
}

export async function consumeTasks(
  nc: NatsConnection,
  handler: TaskHandler,
  opts: ConsumeOptions,
): Promise<() => Promise<void>> {
  const jsm = await nc.jetstreamManager();
  const durableName = `${opts.role}-consumer`;
  try {
    await jsm.consumers.info(STREAM_NAME, durableName);
  } catch {
    await jsm.consumers.add(STREAM_NAME, {
      durable_name: durableName,
      filter_subject: `${SUBJECT_PREFIX}.${opts.role}`,
      ack_policy: AckPolicy.Explicit,
      max_deliver: opts.maxDeliver,
      deliver_policy: DeliverPolicy.All,
    });
  }

  const js = nc.jetstream();
  const consumer = await js.consumers.get(STREAM_NAME, durableName);
  let stopped = false;
  let activeMessages: Awaited<ReturnType<typeof consumer.consume>> | undefined;

  const run = async () => {
    while (!stopped) {
      const messages = await consumer.consume();
      activeMessages = messages;
      for await (const m of messages) {
        const parsed = JSON.parse(m.string()) as TaskMessage;
        try {
          await handler(parsed);
          m.ack();
        } catch (err) {
          if (m.info.deliveryCount >= opts.maxDeliver) {
            await opts.onFinalFailure(parsed, err);
            m.term();
          } else {
            m.nak();
          }
        }
        if (stopped) break;
      }
      activeMessages = undefined;
      if (stopped) break;
    }
  };

  const done = run().catch(() => {
    // Swallow errors caused by closing the iterator during stop().
  });

  return async () => {
    stopped = true;
    await activeMessages?.close();
    await done;
  };
}
