import { describe, it, expect, beforeAll } from 'vitest';
import { Pool } from 'pg';
import { runMigrations } from '../src/db/migrate';
import { seedAgents } from '../src/db/seed-agents';

const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://swarmforge:swarmforge@localhost:5432/swarmforge';

describe('runMigrations', () => {
  beforeAll(async () => {
    await runMigrations(DB_URL);
  });

  it('creates the agents, tasks, and task_events tables', async () => {
    const pool = new Pool({ connectionString: DB_URL });
    const { rows } = await pool.query(`select table_name from information_schema.tables where table_schema = 'public'`);
    const names = rows.map((r: { table_name: string }) => r.table_name);
    expect(names).toEqual(expect.arrayContaining(['agents', 'tasks', 'task_events']));
    await pool.end();
  });

  it('seeds the six agent roles', async () => {
    await seedAgents(DB_URL);
    const pool = new Pool({ connectionString: DB_URL });
    const { rows } = await pool.query('select role from agents order by role');
    expect(rows.map((r: { role: string }) => r.role)).toEqual([
      'architect',
      'coder',
      'deployer',
      'healer',
      'observer',
      'tester',
    ]);
    await pool.end();
  });
});
