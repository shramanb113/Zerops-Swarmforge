import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { createDb, connectQueue, ensureStream } from '@swarmforge/agent-framework';
import { DeployerAgent } from './deployer-agent.js';

async function main(): Promise<void> {
  const databaseUrl = requireEnv('DATABASE_URL');
  const natsUrl = requireEnv('NATS_URL');
  const valkeyUrl = requireEnv('VALKEY_URL');
  requireEnv('GROQ_API_KEY');

  const db = await createDb(databaseUrl);
  const nc = await connectQueue(natsUrl);
  await ensureStream(nc);
  const redis = new Redis(valkeyUrl);
  redis.on('error', (err) => console.error('[valkey] connection error:', err));

  const agent = new DeployerAgent({ db, redis, nc, instanceId: randomUUID() });
  await agent.start();
  console.log(`[agent-deployer] started, DEPLOY_DRY_RUN=${process.env.DEPLOY_DRY_RUN !== 'false'}`);

  process.on('SIGTERM', () => void agent.stop());
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

void main();
