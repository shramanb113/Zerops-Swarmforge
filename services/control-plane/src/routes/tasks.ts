import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { tasks, publishTask } from '@swarmforge/agent-framework';
import type { AppDeps } from '../server.js';

const CreateTaskBody = z.object({
  type: z.string().min(1),
  // `role` is interpolated straight into a NATS subject as `tasks.${role}` by publishTask, and
  // the TASKS stream only captures `tasks.*` (a single token). A role containing a '.' produces
  // a subject that silently matches nothing, and a '*'/'>' would be a wildcard — either way the
  // task row is already inserted by the time publish is attempted, so the row is orphaned as
  // `pending` forever. Restrict to subject-safe characters. Deliberately NOT an enum of the six
  // known agent roles: tasks must be routable to a role before that role's service is deployed,
  // and the tests route to a synthetic role in isolation.
  role: z.string().min(1).regex(/^[a-zA-Z0-9_-]+$/, 'role must contain only letters, numbers, hyphens, and underscores'),
  // z.unknown() alone makes the key optional, so omitting `payload` inserts SQL NULL into a
  // NOT NULL jsonb column and leaks a raw Postgres 23502 error as a 500. Default to {}.
  payload: z.unknown().default({}),
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
