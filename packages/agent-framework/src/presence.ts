import type { Redis } from 'ioredis';

export interface PresenceInfo {
  role: string;
  instanceId: string;
  startedAt: string;
}

const TTL_SECONDS = 10;
const HEARTBEAT_INTERVAL_MS = 4000;

export class PresenceHeartbeat {
  private timer: NodeJS.Timeout | undefined;
  private readonly startedAt = new Date().toISOString();

  constructor(
    private readonly redis: Redis,
    private readonly role: string,
    private readonly instanceId: string,
  ) {}

  private key(): string {
    return `presence:${this.role}:${this.instanceId}`;
  }

  async beat(): Promise<void> {
    const info: PresenceInfo = { role: this.role, instanceId: this.instanceId, startedAt: this.startedAt };
    await this.redis.set(this.key(), JSON.stringify(info), 'EX', TTL_SECONDS);
  }

  start(): void {
    if (this.timer) clearInterval(this.timer);
    // `beat()` writes to Valkey. If Valkey is unreachable, ioredis queues the command and
    // eventually rejects it (after `maxRetriesPerRequest`, default 20). A discarded promise
    // (`void this.beat()`) turns that into an unhandled rejection, which Node treats as fatal —
    // a transient Valkey blip would take the whole agent down. Attach a catch to both the
    // immediate beat and every interval beat so a failed heartbeat is logged and nothing more:
    // the presence key simply expires (TTL 10s) until Valkey comes back and a later beat lands.
    this.beat().catch((err) => this.logBeatError(err));
    this.timer = setInterval(() => {
      this.beat().catch((err) => this.logBeatError(err));
    }, HEARTBEAT_INTERVAL_MS);
  }

  private logBeatError(err: unknown): void {
    console.error(`[presence] heartbeat failed for role "${this.role}" instance "${this.instanceId}":`, err);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

export async function listPresence(redis: Redis): Promise<PresenceInfo[]> {
  const keys = await redis.keys('presence:*');
  if (keys.length === 0) return [];
  const values = await redis.mget(...keys);
  return values.filter((v): v is string => v !== null).map((v) => JSON.parse(v) as PresenceInfo);
}
