import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: '../../packages/agent-framework/src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://swarmforge:swarmforge@localhost:5432/swarmforge',
  },
});
