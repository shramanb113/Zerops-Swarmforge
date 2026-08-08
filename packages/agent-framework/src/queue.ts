import { connect, AckPolicy, DeliverPolicy, nanos, type NatsConnection } from 'nats';
import { withRetry } from './retry.js';

const STREAM_NAME = 'TASKS';
const SUBJECT_PREFIX = 'tasks';

// JetStream's own default ack_wait is 30s. That's fine for the stub `onTask` handlers Foundation
// shipped with, but Coder/Deployer now do real work in-handler (Groq calls, `pnpm install`/`tsc`
// compile checks) that can legitimately run past 30s. Without a longer ack_wait, JetStream treats
// an un-acked-in-time message as lost and redelivers it to the *same* still-running handler,
// producing concurrent duplicate work instead of a clean retry (see
// swarmforge-foundation-carryforward memory item 2, flagged during Foundation for exactly this).
const DEFAULT_ACK_WAIT_MS = 120_000;

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
  /** Defaults to DEFAULT_ACK_WAIT_MS (120s) — see the constant's comment for why. */
  ackWaitMs?: number;
}

export async function consumeTasks(
  nc: NatsConnection,
  handler: TaskHandler,
  opts: ConsumeOptions,
): Promise<() => Promise<void>> {
  const jsm = await nc.jetstreamManager();
  const durableName = `${opts.role}-consumer`;
  const ackWait = nanos(opts.ackWaitMs ?? DEFAULT_ACK_WAIT_MS);
  try {
    const existing = await jsm.consumers.info(STREAM_NAME, durableName);
    // A durable consumer created by an older run (e.g. before this ack_wait/max_deliver was
    // introduced, or by a prior local `vitest` process — JetStream durables outlive the process
    // that created them) can be left with a stale config. Reconcile it on every start instead of
    // trusting whatever the first-ever `consumers.add` call for this role happened to set.
    if (existing.config.ack_wait !== ackWait || existing.config.max_deliver !== opts.maxDeliver) {
      await jsm.consumers.update(STREAM_NAME, durableName, {
        ack_wait: ackWait,
        max_deliver: opts.maxDeliver,
      });
    }
  } catch {
    await jsm.consumers.add(STREAM_NAME, {
      durable_name: durableName,
      filter_subject: `${SUBJECT_PREFIX}.${opts.role}`,
      ack_policy: AckPolicy.Explicit,
      max_deliver: opts.maxDeliver,
      deliver_policy: DeliverPolicy.All,
      ack_wait: ackWait,
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
          // JSON.parse must stay inside a try: a single malformed payload used to throw
          // straight out of this for-await, unwinding run() and permanently killing this
          // role's consumer — while PresenceHeartbeat kept beating, so /presence reported the
          // role healthy while its tasks sat `in_progress` forever. A poison message is
          // unfixable by redelivery, so term() it and keep serving the rest of the stream.
          let parsed: TaskMessage;
          try {
            parsed = JSON.parse(m.string()) as TaskMessage;
          } catch (parseErr) {
            console.error(
              `[queue] consumeTasks: malformed payload for role "${opts.role}" (deliveryCount ${m.info.deliveryCount}), terminating message:`,
              parseErr,
            );
            m.term();
            if (stopped) break;
            continue;
          }
          try {
            await handler(parsed);
            m.ack();
          } catch (err) {
            if (m.info.deliveryCount >= opts.maxDeliver) {
              // onFinalFailure writes to Postgres (see ZeropsAgent.recordFailure). If that
              // write fails, the throw would escape the for-await and kill the consumer for
              // good — the same failure mode as an unguarded parse. Log and still term(), so
              // one unrecordable failure never takes the whole role offline.
              try {
                await opts.onFinalFailure(parsed, err);
              } catch (finalErr) {
                console.error(
                  `[queue] onFinalFailure threw for role "${opts.role}", taskId "${parsed.taskId}":`,
                  finalErr,
                );
              }
              m.term();
            } else {
              // nak() with no argument redelivers immediately, which burns every maxDeliver
              // attempt in milliseconds — a task is marked permanently `failed` before a
              // transient dependency (Postgres/Valkey blip) had any chance to recover.
              // Back off exponentially from the delivery count: 1s, 2s, 4s, ... capped at 30s.
              const backoffMs = Math.min(1000 * 2 ** (m.info.deliveryCount - 1), 30_000);
              m.nak(backoffMs);
            }
          }
          if (stopped) break;
        }
      } finally {
        // Every per-message failure is now handled inside the loop, but genuine
        // iterator/connection-level failures still throw out of this for-await. Left stale,
        // a later stop() would call `.close()` on an iterator that already died when the
        // exception unwound it — and that call never resolves. Clearing it here, in `finally`,
        // runs on every exit path (normal completion, `break`, or a thrown iterator error), so
        // stop() always sees `undefined` once this iterator is no longer live and skips the hang.
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
  // consumer — throws a real Error out of the `for await`; per-message failures, including
  // malformed payloads, are now all handled inside the loop and never reach here). So there is
  // no "expected" error shape to swallow here: anything that reaches
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
