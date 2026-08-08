import { Redis } from 'ioredis';
import { createDb, connectQueue, ensureStream } from '@swarmforge/agent-framework';
import { buildServer } from './server.js';
import { runMigrations } from './db/migrate.js';
import { seedAgents } from './db/seed-agents.js';

async function main(): Promise<void> {
  const databaseUrl = requireEnv('DATABASE_URL');
  const natsUrl = requireEnv('NATS_URL');
  const valkeyUrl = requireEnv('VALKEY_URL');

  await runMigrations(databaseUrl);
  await seedAgents(databaseUrl);

  const db = await createDb(databaseUrl);
  const nc = await connectQueue(natsUrl);
  await ensureStream(nc);
  const redis = new Redis(valkeyUrl);

  const app = buildServer({ db, nc, redis });
  const port = Number(process.env.PORT ?? 3000);
  await app.listen({ host: '0.0.0.0', port });
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

void main();
