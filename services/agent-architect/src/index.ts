import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { createDb, connectQueue, ensureStream } from '@swarmforge/agent-framework';
import { ArchitectAgent } from './architect-agent.js';

async function main(): Promise<void> {
  const databaseUrl = requireEnv('DATABASE_URL');
  const natsUrl = requireEnv('NATS_URL');
  const valkeyUrl = requireEnv('VALKEY_URL');
  requireEnv('GROQ_API_KEY'); // read by Mastra's model router directly from process.env

  const db = await createDb(databaseUrl);
  const nc = await connectQueue(natsUrl);
  await ensureStream(nc);
  const redis = new Redis(valkeyUrl);
  // ioredis emits 'error' on connection failures. An EventEmitter with no 'error' listener
  // throws, so without this a Valkey blip would crash the process.
  redis.on('error', (err) => console.error('[valkey] connection error:', err));

  const instanceId = randomUUID();
  const agent = new ArchitectAgent({ db, redis, nc, instanceId, databaseUrl });
  await agent.start();
  // Log only the instance id, never the agent object itself — it carries `databaseUrl`
  // (with the Postgres password) as an ordinary enumerable property at runtime, since
  // TypeScript's `private`/`protected` modifiers are compile-time only.
  console.log('[agent-architect] started, instance', instanceId);

  process.on('SIGTERM', () => void agent.stop());
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

void main();
