import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { ZeropsAgent, type ZeropsAgentDeps, createAgent, slugify, products, taskEvents, and, eq } from '@swarmforge/agent-framework';
import { renderZeropsYaml, renderServiceImportYaml } from './deploy-template.js';

const execFileAsync = promisify(execFile);

const TaskPayload = z.object({ productId: z.string().uuid() });
// `process.cwd()` varies by invocation (a service's own directory when run via `pnpm --filter
// X dev`, but the repo root when the same code runs inside vitest via the root `test` script) -
// resolving relative to import.meta.url is stable regardless of how/where the process started.
const PRODUCTS_ROOT = fileURLToPath(new URL('../../../products', import.meta.url));

type DeployerDeps = Omit<ZeropsAgentDeps, 'role'> & {
  model?: Parameters<typeof createAgent>[0]['model'];
};

export class DeployerAgent extends ZeropsAgent {
  private readonly agentModel: Parameters<typeof createAgent>[0]['model'];
  private readonly dryRun: boolean;

  constructor(deps: DeployerDeps) {
    super({ ...deps, role: 'deployer' });
    this.agentModel = deps.model;
    // Default true whenever unset OR set to anything other than the literal string "false" -
    // an operator must opt in explicitly, never accidentally, to spending real Zerops credit.
    this.dryRun = process.env.DEPLOY_DRY_RUN !== 'false';
  }

  async onTask(payload: unknown): Promise<void> {
    const { productId } = TaskPayload.parse(payload);
    const taskId = this.currentTaskId!;

    const [product] = await this.db.select().from(products).where(eq(products.id, productId));
    if (!product) throw new Error(`product ${productId} not found`);

    // Idempotency guard, mirroring ArchitectAgent's and CoderAgent's: NATS redelivers this exact
    // task on any thrown error, up to maxDeliver attempts. A `deploy_recorded` event means the
    // deploy config was already written and the (dry-run) zcli sequence already logged, so
    // redoing it would burn another LLM round-trip and append a second, contradictory event.
    const [existingDeployRecorded] = await this.db
      .select()
      .from(taskEvents)
      .where(and(eq(taskEvents.taskId, taskId), eq(taskEvents.eventType, 'deploy_recorded')));
    if (existingDeployRecorded) {
      await this.db.update(products).set({ status: 'deployed', updatedAt: new Date() }).where(eq(products.id, productId));
      return;
    }

    const productDir = path.join(PRODUCTS_ROOT, productId);
    // Re-slugify at the point of use rather than trusting that whoever wrote this row already
    // did. This value becomes a Zerops hostname and a zcli argument; the global constraint is
    // that such a name is always slugify() output, and that must hold as an invariant, not as a
    // convention that happens to be true because ArchitectAgent is currently the only writer.
    // slugify is idempotent, so this is a no-op on already-slugified names.
    const hostname = slugify(product.name);

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
        // These two zcli operations have genuinely different subcommand shapes - importing
        // services is nested under `project`, pushing a build is top-level:
        //   zcli project service-import <file>
        //   zcli push <service> [--project-id <id>]
        // (see docs/superpowers/plans/2026-08-05-swarmforge-foundation.md, Task 12, which uses
        // both against the real project). Blanket-prefixing every command with 'project'
        // produced `zcli project push <service>`, which is not a real command - so the dry-run
        // log, the only artifact this step actually produces today, was recording invocations
        // that could never have worked had dry-run been off.
        const fullArgs = context.command === 'service-import'
          ? ['project', 'service-import', ...context.args]
          : ['push', ...context.args];
        commands.push(`zcli ${fullArgs.join(' ')}`);
        if (this.dryRun) {
          console.log(`[agent-deployer] DRY RUN, not executing: zcli ${fullArgs.join(' ')}`);
          return { dryRun: true, executed: false };
        }
        // No `shell: true`. `args` is LLM-controlled, and under a shell every element is
        // re-parsed by the shell, so a single arg containing `;` or backticks becomes arbitrary
        // command execution. Without it, execFile passes argv straight to the process and the
        // args are inert data no matter what the model puts in them. This closes that class of
        // bug permanently, independently of the dry-run gate above.
        await execFileAsync('zcli', fullArgs, { cwd: productDir });
        return { dryRun: false, executed: true };
      },
    };

    const agent = createAgent({
      id: 'deployer',
      name: 'Deployer',
      instructions:
        `Deploy the product "${hostname}". Make exactly three tool calls, in this order:\n` +
        `1. write_deploy_config with hostname="${hostname}".\n` +
        '2. run_zcli with command="service-import" and args=["zerops-service-import.yaml"] ' +
        '(this runs `zcli project service-import zerops-service-import.yaml`).\n' +
        `3. run_zcli with command="push" and args=["${hostname}"] ` +
        `(this runs \`zcli push ${hostname}\`).\n` +
        'Then report what you did in one sentence.',
      model: this.agentModel,
      // Keys must match the toolName a tool-call refers to - the map key is the tool's public
      // name from the model's perspective, not the local variable name it's assigned from.
      tools: { write_deploy_config: writeDeployConfigTool, run_zcli: runZcliTool },
    });

    await agent.generate(`Deploy "${hostname}" now, in the order described in your instructions.`);

    await this.db.insert(taskEvents).values({
      taskId,
      role: 'deployer',
      eventType: 'deploy_recorded',
      payload: { dryRun: this.dryRun, commands },
    });

    await this.db.update(products).set({ status: 'deployed', updatedAt: new Date() }).where(eq(products.id, productId));
  }
}
