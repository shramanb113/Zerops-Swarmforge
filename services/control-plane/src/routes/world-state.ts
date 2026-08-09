import type { FastifyInstance } from 'fastify';
import { desc } from 'drizzle-orm';
import { tasks, taskEvents, products, architectureProposals } from '@swarmforge/agent-framework';
import type { AppDeps } from '../server.js';

export function registerWorldStateRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get('/world-state', async () => {
    const recentTasks = await deps.db.select().from(tasks).orderBy(desc(tasks.createdAt)).limit(50);
    const recentEvents = await deps.db.select().from(taskEvents).orderBy(desc(taskEvents.createdAt)).limit(100);
    const recentProducts = await deps.db.select().from(products).orderBy(desc(products.createdAt)).limit(50);
    // Proposals are the only join between an architect task and the product its pipeline went on
    // to build (`architecture_proposals.task_id` -> `tasks.id`, `.product_id` -> `products.id`).
    // Without them a consumer of this endpoint can only see "some product reached status X", not
    // "the product *my* task produced reached status X" - which is exactly how scripts/smoke.ts
    // was previously able to pass against leftover rows from an unrelated earlier run.
    const recentProposals = await deps.db
      .select()
      .from(architectureProposals)
      .orderBy(desc(architectureProposals.createdAt))
      .limit(50);
    return { tasks: recentTasks, events: recentEvents, products: recentProducts, proposals: recentProposals };
  });
}
