import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { withRetry } from '../retry.js';
import * as schema from './schema.js';

export type Db = NodePgDatabase<typeof schema>;

export async function createDb(connectionString: string): Promise<Db> {
  const pool = new Pool({ connectionString });
  await withRetry(async () => {
    const client = await pool.connect();
    client.release();
  });
  return drizzle(pool, { schema });
}
