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
    void this.beat();
    this.timer = setInterval(() => void this.beat(), HEARTBEAT_INTERVAL_MS);
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
