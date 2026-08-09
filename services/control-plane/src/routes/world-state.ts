import type { FastifyInstance } from 'fastify';
import { desc } from 'drizzle-orm';
import { tasks, taskEvents } from '@swarmforge/agent-framework';
import type { AppDeps } from '../server.js';

export function registerWorldStateRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get('/world-state', async () => {
    const recentTasks = await deps.db.select().from(tasks).orderBy(desc(tasks.createdAt)).limit(50);
    const recentEvents = await deps.db.select().from(taskEvents).orderBy(desc(taskEvents.createdAt)).limit(100);
    return { tasks: recentTasks, events: recentEvents };
  });
}
