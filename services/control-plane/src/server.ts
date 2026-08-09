import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import type { Db } from '@swarmforge/agent-framework';
import type { NatsConnection } from 'nats';
import type { Redis } from 'ioredis';
import { ZodError } from 'zod';
import { registerTaskRoutes } from './routes/tasks.js';
import { registerWorldStateRoutes } from './routes/world-state.js';
import { registerPresenceRoutes } from './routes/presence.js';

export interface AppDeps {
  db: Db;
  nc: NatsConnection;
  redis: Redis;
}

export function buildServer(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: true });
  // The dashboard is a separately-hosted Next.js app (Vercel), not same-origin with
  // control-plane (Zerops) - without this every fetch() from it is blocked by the browser.
  // Every route here is already unauthenticated by design, so reflecting any origin adds no
  // new exposure.
  void app.register(cors, { origin: true });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: 'Invalid request', issues: error.issues });
    }
    return reply.send(error);
  });
  registerTaskRoutes(app, deps);
  registerWorldStateRoutes(app, deps);
  registerPresenceRoutes(app, deps);
  return app;
}
