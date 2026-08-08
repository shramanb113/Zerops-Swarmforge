import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { tasks, publishTask } from '@swarmforge/agent-framework';
import type { AppDeps } from '../server.js';

const CreateTaskBody = z.object({
  type: z.string().min(1),
  role: z.string().min(1),
  payload: z.unknown(),
});

export function registerTaskRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.post('/tasks', async (request, reply) => {
    const body = CreateTaskBody.parse(request.body);
    const id = randomUUID();

    await deps.db.insert(tasks).values({
      id,
      type: body.type,
      role: body.role,
      payload: body.payload,
      status: 'pending',
    });

    await publishTask(deps.nc, body.role, { taskId: id, role: body.role, payload: body.payload });

    return reply.code(201).send({ id, status: 'pending' });
  });
}
