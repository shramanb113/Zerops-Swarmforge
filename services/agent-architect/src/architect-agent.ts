import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ZeropsAgent, type ZeropsAgentDeps, createAgent, slugify, products, architectureProposals, eq, LANGUAGES } from '@swarmforge/agent-framework';

const ProposalSchema = z.object({
  serviceName: z.string().min(1),
  summary: z.string().min(1),
  responsibilities: z.array(z.string()),
  endpoints: z.array(z.object({ method: z.string(), path: z.string() })),
  dataModel: z.record(z.unknown()),
  language: z.enum(LANGUAGES),
});

const TaskPayload = z.object({ description: z.string().min(1) });

type ArchitectDeps = Omit<ZeropsAgentDeps, 'role'> & {
  model?: Parameters<typeof createAgent>[0]['model'];
  controlPlaneUrl?: string;
};

export class ArchitectAgent extends ZeropsAgent {
  private readonly controlPlaneUrl: string;
  private readonly agentModel: Parameters<typeof createAgent>[0]['model'];

  constructor(deps: ArchitectDeps) {
    super({ ...deps, role: 'architect' });
    this.agentModel = deps.model;
    this.controlPlaneUrl = deps.controlPlaneUrl ?? process.env.CONTROL_PLANE_URL ?? 'http://localhost:3000';
  }

  async onTask(payload: unknown): Promise<void> {
    const { description } = TaskPayload.parse(payload);
    const taskId = this.currentTaskId;

    // Idempotency guard: NATS redelivers this same task on any thrown error (e.g. a transient
    // control-plane blip during the handoff POST below), up to maxDeliver attempts. Without this
    // check, a redelivery after a successful insert-but-failed-handoff would generate and insert
    // a second, duplicate product/proposal pair. Reuse the first attempt's rows instead of
    // re-running the LLM call and re-inserting.
    const [existingProposal] = taskId
      ? await this.db.select().from(architectureProposals).where(eq(architectureProposals.taskId, taskId))
      : [];

    let productId: string;
    let proposalId: string;

    if (existingProposal) {
      productId = existingProposal.productId;
      proposalId = existingProposal.id;
    } else {
      const agent = createAgent({
        id: 'architect',
        name: 'Architect',
        instructions:
          'You design a single backend service, plus a minimal companion ' +
          'frontend UI for it, from a product description. Propose exactly one backend service: ' +
          'a short name, a list of responsibilities, a list of REST endpoints (method + path), ' +
          'and a simple data model. Do not propose multiple services.\n' +
          'This product\'s backend can be built in TypeScript, Python, Go, or Rust. If the ' +
          'product description explicitly names one of these four languages, use it. Otherwise, ' +
          'pick whichever fits best: Go or Rust for CPU- or concurrency-heavy work, Python for ' +
          'data-shaped or scripting-flavored products, TypeScript for everything else. Always ' +
          'pick exactly one of the four - never propose a fifth language.\n' +
          'The summary must be two short paragraphs: first the backend service, then a second ' +
          'paragraph starting "Frontend:" describing the ONE screen a minimal, clean UI for this ' +
          'product would show and the key actions a user takes on it - concrete enough that ' +
          'someone could build it without asking follow-up questions, but no more than a few ' +
          'sentences.',
        model: this.agentModel,
      });

      const response = await agent.generate(`Product description: ${description}`, {
        output: ProposalSchema,
      });
      const proposal = ProposalSchema.parse(response.object);

      const name = slugify(proposal.serviceName);
      productId = randomUUID();

      await this.db.insert(products).values({
        id: productId,
        name,
        description,
        language: proposal.language,
        status: 'proposed',
      });

      proposalId = randomUUID();
      await this.db.insert(architectureProposals).values({
        id: proposalId,
        productId,
        taskId,
        serviceName: name,
        summary: proposal.summary,
        endpoints: proposal.endpoints,
        dataModel: proposal.dataModel,
      });
    }

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
