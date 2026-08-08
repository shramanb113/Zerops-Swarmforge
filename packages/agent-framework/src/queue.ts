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
      if (stopped) {
        // stop() was invoked while consumer.consume()'s round trip was in flight, so
        // stop()'s own `activeMessages?.close()` ran against `undefined` and was a no-op.
        // This freshly-resolved iterator was never observed by stop() and is about to be
        // entered by `for await` below, which would otherwise block forever waiting for a
        // message that will never arrive. Close it now and exit without iterating so
        // stop()'s `await done` always resolves in bounded time.
        await messages.close();
        break;
      }
      activeMessages = messages;
      try {
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
      } finally {
        // JSON.parse (above) is not inside the handler's try/catch, so a malformed payload
        // throws straight out of this for-await loop, skipping the `activeMessages = undefined`
        // that used to sit after it unguarded. Left stale, a later stop() would call
        // `.close()` on an iterator that already died when the exception unwound it — and that
        // call never resolves. Clearing it here, in `finally`, runs on every exit path (normal
        // completion, `break`, or a thrown parse error), so stop() always sees `undefined` once
        // this iterator is no longer live and skips the hang.
        activeMessages = undefined;
      }
      if (stopped) break;
    }
  };

  // A clean, stop()-triggered iterator close (via activeMessages.close()/messages.close()
  // above) never rejects `run()` — the underlying nats.js `ConsumerMessages` iterator simply
  // completes its `for await` normally with no thrown error (verified empirically against the
  // installed nats@2.29.3: closing an idle/active consume() iterator resolves the async
  // generator's `finally` without an error, whereas a genuine failure — e.g. a deleted/missing
  // consumer, or a JSON.parse failure on a malformed payload — throws a real Error out of the
  // `for await`). So there is no "expected" error shape to swallow here: anything that reaches
  // this catch is an unexpected failure, and silently dropping it would kill this role's
  // consumer with no observable signal. Log it instead.
  const done = run().catch((err) => {
    console.error(
      `[queue] consumeTasks: consumer loop for role "${opts.role}" exited unexpectedly` +
        (stopped ? ' during shutdown' : '') +
        ':',
      err,
    );
  });

  return async () => {
    stopped = true;
    await activeMessages?.close();
    await done;
  };
}
