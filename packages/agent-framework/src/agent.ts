import type { NatsConnection } from 'nats';
import type { Redis } from 'ioredis';
import { eq } from 'drizzle-orm';
import type { Db } from './db/client.js';
import { tasks, taskEvents } from './db/schema.js';
import { PresenceHeartbeat } from './presence.js';
import { consumeTasks, type TaskMessage } from './queue.js';

export interface ZeropsAgentDeps {
  db: Db;
  redis: Redis;
  nc: NatsConnection;
  role: string;
  instanceId: string;
  maxDeliver?: number;
}

export abstract class ZeropsAgent {
  protected readonly db: Db;
  private readonly redis: Redis;
  private readonly nc: NatsConnection;
  private readonly role: string;
  private readonly instanceId: string;
  private readonly maxDeliver: number;
  private readonly presence: PresenceHeartbeat;
  private stopConsuming: (() => Promise<void>) | undefined;

  constructor(deps: ZeropsAgentDeps) {
    this.db = deps.db;
    this.redis = deps.redis;
    this.nc = deps.nc;
    this.role = deps.role;
    this.instanceId = deps.instanceId;
    this.maxDeliver = deps.maxDeliver ?? 5;
    this.presence = new PresenceHeartbeat(this.redis, this.role, this.instanceId);
  }

  abstract onTask(payload: unknown): Promise<void>;

  async onStart(): Promise<void> {}
  async onStop(): Promise<void> {}

  async start(): Promise<void> {
    this.presence.start();
    await this.onStart();
    this.stopConsuming = await consumeTasks(this.nc, (msg) => this.handleTask(msg), {
      role: this.role,
      maxDeliver: this.maxDeliver,
      onFinalFailure: (msg, err) => this.recordFailure(msg, err),
    });
  }

  async stop(): Promise<void> {
    this.presence.stop();
    if (this.stopConsuming) await this.stopConsuming();
    await this.onStop();
  }

  private async handleTask(msg: TaskMessage): Promise<void> {
    await this.db.update(tasks).set({ status: 'in_progress', updatedAt: new Date() }).where(eq(tasks.id, msg.taskId));
    await this.logEvent(msg.taskId, 'task_started', {});

    await this.onTask(msg.payload);

    await this.db.update(tasks).set({ status: 'done', updatedAt: new Date() }).where(eq(tasks.id, msg.taskId));
    await this.logEvent(msg.taskId, 'task_completed', {});
  }

  private async recordFailure(msg: TaskMessage, err: unknown): Promise<void> {
    await this.db.update(tasks).set({ status: 'failed', updatedAt: new Date() }).where(eq(tasks.id, msg.taskId));
    await this.logEvent(msg.taskId, 'task_failed', { error: String(err) });
  }

  private async logEvent(taskId: string, eventType: string, payload: unknown): Promise<void> {
    await this.db.insert(taskEvents).values({ taskId, role: this.role, eventType, payload });
  }
}
