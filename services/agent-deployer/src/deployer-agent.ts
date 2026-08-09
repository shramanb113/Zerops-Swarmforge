import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { ZeropsAgent, type ZeropsAgentDeps, createAgent, products, taskEvents, eq } from '@swarmforge/agent-framework';
import { renderZeropsYaml, renderServiceImportYaml } from './deploy-template.js';

const execFileAsync = promisify(execFile);

const TaskPayload = z.object({ productId: z.string().uuid() });
// `process.cwd()` varies by invocation (a service's own directory when run via `pnpm --filter
// X dev`, but the repo root when the same code runs inside vitest via the root `test` script) -
// resolving relative to import.meta.url is stable regardless of how/where the process started.
const PRODUCTS_ROOT = fileURLToPath(new URL('../../../products', import.meta.url));

type DeployerDeps = Omit<ZeropsAgentDeps, 'role'> & {
  model?: Parameters<typeof createAgent>[0]['model'];
  databaseUrl?: string;
};

export class DeployerAgent extends ZeropsAgent {
  private readonly agentModel: Parameters<typeof createAgent>[0]['model'];
  private readonly databaseUrl: string;
  private readonly dryRun: boolean;

  constructor(deps: DeployerDeps) {
    super({ ...deps, role: 'deployer' });
    this.agentModel = deps.model;
    this.databaseUrl = deps.databaseUrl ?? requireEnv('DATABASE_URL');
    // Default true whenever unset OR set to anything other than the literal string "false" -
    // an operator must opt in explicitly, never accidentally, to spending real Zerops credit.
    this.dryRun = process.env.DEPLOY_DRY_RUN !== 'false';
  }

  async onTask(payload: unknown): Promise<void> {
    const { productId } = TaskPayload.parse(payload);

    const [product] = await this.db.select().from(products).where(eq(products.id, productId));
    if (!product) throw new Error(`product ${productId} not found`);

    const productDir = path.join(PRODUCTS_ROOT, productId);
    const hostname = product.name;

    const writeDeployConfigTool = {
      id: 'write_deploy_config',
      description: 'Write the zerops.yaml and service-import YAML for this product. hostname must be the product name.',
      inputSchema: z.object({ hostname: z.string() }),
      outputSchema: z.object({ written: z.boolean() }),
      execute: async ({ context }: { context: { hostname: string } }) => {
        await writeFile(path.join(productDir, 'zerops.yaml'), renderZeropsYaml(hostname), 'utf-8');
        await writeFile(path.join(productDir, 'zerops-service-import.yaml'), renderServiceImportYaml(hostname), 'utf-8');
        return { written: true };
      },
    };

    const commands: string[] = [];
    const runZcliTool = {
      id: 'run_zcli',
      description: 'Run a zcli command against the real Zerops project. Defaults to dry-run (logs only).',
      inputSchema: z.object({
        command: z.enum(['service-import', 'push']),
        args: z.array(z.string()),
      }),
      outputSchema: z.object({ dryRun: z.boolean(), executed: z.boolean() }),
      execute: async ({ context }: { context: { command: 'service-import' | 'push'; args: string[] } }) => {
        const fullArgs = ['project', context.command, ...context.args];
        commands.push(`zcli ${fullArgs.join(' ')}`);
        if (this.dryRun) {
          console.log(`[agent-deployer] DRY RUN, not executing: zcli ${fullArgs.join(' ')}`);
          return { dryRun: true, executed: false };
        }
        await execFileAsync('zcli', fullArgs, { cwd: productDir, shell: true });
        return { dryRun: false, executed: true };
      },
    };

    const agent = createAgent({
      id: 'deployer',
      name: 'Deployer',
      instructions:
        `Deploy the product "${hostname}". First call write_deploy_config with hostname="${hostname}". ` +
        'Then call run_zcli with command="service-import" and args=["zerops-service-import.yaml"], ' +
        `then command="push" and args=["${hostname}"]. Report what you did in one sentence.`,
      model: this.agentModel,
      databaseUrl: this.databaseUrl,
      // Keys must match the toolName a tool-call refers to - the map key is the tool's public
      // name from the model's perspective, not the local variable name it's assigned from.
      tools: { write_deploy_config: writeDeployConfigTool, run_zcli: runZcliTool },
    });

    await agent.generate(`Deploy "${hostname}" now, in the order described in your instructions.`);

    await this.db.insert(taskEvents).values({
      taskId: this.currentTaskId!,
      role: 'deployer',
      eventType: 'deploy_recorded',
      payload: { dryRun: this.dryRun, commands },
    });

    await this.db.update(products).set({ status: 'deployed', updatedAt: new Date() }).where(eq(products.id, productId));
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
