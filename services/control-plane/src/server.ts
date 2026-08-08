import Fastify, { type FastifyInstance } from 'fastify';
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
