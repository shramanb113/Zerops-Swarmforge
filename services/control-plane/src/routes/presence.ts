import type { FastifyInstance } from 'fastify';
import { listPresence } from '@swarmforge/agent-framework';
import type { AppDeps } from '../server.js';

export function registerPresenceRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get('/presence', async () => {
    const agentsOnline = await listPresence(deps.redis);
    return { agents: agentsOnline };
  });
}
