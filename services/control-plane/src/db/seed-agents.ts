import { createDb, agents } from '@swarmforge/agent-framework';

const ROLES: Array<{ role: string; displayName: string }> = [
  { role: 'architect', displayName: 'Architect' },
  { role: 'coder', displayName: 'Coder' },
  { role: 'deployer', displayName: 'Deployer' },
  { role: 'tester', displayName: 'Tester' },
  { role: 'observer', displayName: 'Observer' },
  { role: 'healer', displayName: 'Healer' },
];

export async function seedAgents(databaseUrl: string): Promise<void> {
  const db = await createDb(databaseUrl);
  await db.insert(agents).values(ROLES).onConflictDoNothing();
}
