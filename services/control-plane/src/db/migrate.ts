import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath } from 'node:url';
import { createDb } from '@swarmforge/agent-framework';

export async function runMigrations(databaseUrl: string): Promise<void> {
  const db = await createDb(databaseUrl);
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../drizzle', import.meta.url)) });
}
