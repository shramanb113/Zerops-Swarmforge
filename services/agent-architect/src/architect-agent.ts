import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ZeropsAgent, type ZeropsAgentDeps, createAgent, slugify, products, architectureProposals } from '@swarmforge/agent-framework';

const ProposalSchema = z.object({
  serviceName: z.string().min(1),
  summary: z.string().min(1),
  responsibilities: z.array(z.string()),
  endpoints: z.array(z.object({ method: z.string(), path: z.string() })),
  dataModel: z.record(z.unknown()),
});

const TaskPayload = z.object({ description: z.string().min(1) });

type ArchitectDeps = Omit<ZeropsAgentDeps, 'role'> & {
  model?: Parameters<typeof createAgent>[0]['model'];
  databaseUrl?: string;
  controlPlaneUrl?: string;
};

export class ArchitectAgent extends ZeropsAgent {
  private readonly controlPlaneUrl: string;
  private readonly agentModel: Parameters<typeof createAgent>[0]['model'];
  private readonly databaseUrl: string;

  constructor(deps: ArchitectDeps) {
    super({ ...deps, role: 'architect' });
    this.agentModel = deps.model;
    this.databaseUrl = deps.databaseUrl ?? requireEnv('DATABASE_URL');
    this.controlPlaneUrl = deps.controlPlaneUrl ?? process.env.CONTROL_PLANE_URL ?? 'http://localhost:3000';
  }

  async onTask(payload: unknown): Promise<void> {
    const { description } = TaskPayload.parse(payload);

    const agent = createAgent({
      id: 'architect',
      name: 'Architect',
      instructions:
        'You design a single Node.js/TypeScript backend service from a product description. ' +
        'Propose exactly one service: a short name, a one-paragraph summary, a list of ' +
        'responsibilities, a list of REST endpoints (method + path), and a simple data model. ' +
        'Do not propose multiple services or a non-Node.js stack.',
      model: this.agentModel,
      databaseUrl: this.databaseUrl,
    });

    const response = await agent.generate(`Product description: ${description}`, {
      output: ProposalSchema,
    });
    const proposal = ProposalSchema.parse(response.object);

    const productId = randomUUID();
    const name = slugify(proposal.serviceName);

    await this.db.insert(products).values({
      id: productId,
      name,
      description,
      status: 'proposed',
    });

    const proposalId = randomUUID();
    await this.db.insert(architectureProposals).values({
      id: proposalId,
      productId,
      taskId: this.currentTaskId,
      serviceName: name,
      summary: proposal.summary,
      endpoints: proposal.endpoints,
      dataModel: proposal.dataModel,
    });

    const res = await fetch(`${this.controlPlaneUrl}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'build-product',
        role: 'coder',
        payload: { productId, proposalId },
      }),
    });
    if (!res.ok) {
      throw new Error(`failed to hand off to coder: POST /tasks returned ${res.status}`);
    }
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
