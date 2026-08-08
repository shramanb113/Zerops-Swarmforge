import { ZeropsAgent, type ZeropsAgentDeps } from '@swarmforge/agent-framework';

export class ArchitectAgent extends ZeropsAgent {
  constructor(deps: Omit<ZeropsAgentDeps, 'role'>) {
    super({ ...deps, role: 'architect' });
  }

  async onTask(payload: unknown): Promise<void> {
    console.log('agent-architect received task (stub, no LLM call yet):', payload);
  }
}
