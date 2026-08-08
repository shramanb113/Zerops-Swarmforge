import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  ZeropsAgent, type ZeropsAgentDeps, createAgent, resolveScopedPath,
  products, architectureProposals, taskEvents, eq,
} from '@swarmforge/agent-framework';
import { scaffoldProduct } from './product-template.js';

const execAsync = promisify(exec);

const TaskPayload = z.object({ productId: z.string().uuid(), proposalId: z.string().uuid() });

// `process.cwd()` varies by invocation (a service's own directory when run via `pnpm --filter
// X dev`, but the repo root when the same code runs inside vitest via the root `test` script) -
// resolving relative to import.meta.url is stable regardless of how/where the process started.
const PRODUCTS_ROOT = fileURLToPath(new URL('../../../products', import.meta.url));

type CoderDeps = Omit<ZeropsAgentDeps, 'role'> & {
  model?: Parameters<typeof createAgent>[0]['model'];
  databaseUrl?: string;
  controlPlaneUrl?: string;
};

export class CoderAgent extends ZeropsAgent {
  private readonly controlPlaneUrl: string;
  private readonly agentModel: Parameters<typeof createAgent>[0]['model'];
  private readonly databaseUrl: string;

  constructor(deps: CoderDeps) {
    super({ ...deps, role: 'coder' });
    this.agentModel = deps.model;
    this.databaseUrl = deps.databaseUrl ?? requireEnv('DATABASE_URL');
    this.controlPlaneUrl = deps.controlPlaneUrl ?? process.env.CONTROL_PLANE_URL ?? 'http://localhost:3000';
  }

  async onTask(payload: unknown): Promise<void> {
    const { productId } = TaskPayload.parse(payload);

    const [product] = await this.db.select().from(products).where(eq(products.id, productId));
    if (!product) throw new Error(`product ${productId} not found`);
    const [proposal] = await this.db
      .select()
      .from(architectureProposals)
      .where(eq(architectureProposals.productId, productId));
    if (!proposal) throw new Error(`no architecture proposal found for product ${productId}`);

    const productDir = path.join(PRODUCTS_ROOT, productId);
    await scaffoldProduct(productDir, product.name);

    const writtenFiles: string[] = [];
    const writeFileTool = this.buildWriteFileTool(productDir, writtenFiles);
    const readFileTool = this.buildReadFileTool(productDir);

    const agent = createAgent({
      id: 'coder',
      name: 'Coder',
      instructions:
        'You implement a Node.js/TypeScript Fastify service inside src/. Use the write_file tool ' +
        'for every file you create; paths are relative to src/. Always write at least src/index.ts, ' +
        'a Fastify server listening on process.env.PORT (default 3000) that implements every ' +
        'endpoint from the proposal. Do not write package.json or tsconfig.json - those already exist.',
      model: this.agentModel,
      databaseUrl: this.databaseUrl,
      // Keys must match the toolName a tool-call refers to - the map key is the tool's public
      // name from the model's perspective, not the local variable name it's assigned from.
      tools: { write_file: writeFileTool, read_file: readFileTool },
    });

    await agent.generate(
      `Architecture proposal for "${proposal.serviceName}": ${proposal.summary}\n` +
        `Endpoints: ${JSON.stringify(proposal.endpoints)}\n` +
        `Data model: ${JSON.stringify(proposal.dataModel)}\n` +
        'Implement this service now, writing every file with the write_file tool.',
    );

    await this.db.update(products).set({ status: 'coding', updatedAt: new Date() }).where(eq(products.id, productId));

    const compileResult = await this.compileCheck(productDir);
    if (!compileResult.ok) {
      await this.db.update(products).set({ status: 'failed', updatedAt: new Date() }).where(eq(products.id, productId));
      await this.db.insert(taskEvents).values({
        taskId: this.currentTaskId!,
        role: 'coder',
        eventType: 'compile_failed',
        payload: { output: compileResult.output },
      });
      throw new Error(`generated product ${productId} failed to compile:\n${compileResult.output}`);
    }

    await this.db.insert(taskEvents).values({
      taskId: this.currentTaskId!,
      role: 'coder',
      eventType: 'code_generated',
      payload: { files: writtenFiles },
    });

    const res = await fetch(`${this.controlPlaneUrl}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'build-product', role: 'deployer', payload: { productId } }),
    });
    if (!res.ok) {
      throw new Error(`failed to hand off to deployer: POST /tasks returned ${res.status}`);
    }
  }

  private buildWriteFileTool(productDir: string, writtenFiles: string[]) {
    const srcRoot = path.join(productDir, 'src');
    return {
      id: 'write_file',
      description: 'Write a file inside the product\'s src/ directory. Path is relative to src/.',
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      outputSchema: z.object({ written: z.boolean() }),
      execute: async ({ context }: { context: { path: string; content: string } }) => {
        const { writeFile, mkdir } = await import('node:fs/promises');
        const resolved = resolveScopedPath(srcRoot, context.path);
        await mkdir(path.dirname(resolved), { recursive: true });
        await writeFile(resolved, context.content, 'utf-8');
        writtenFiles.push(context.path);
        return { written: true };
      },
    };
  }

  private buildReadFileTool(productDir: string) {
    const srcRoot = path.join(productDir, 'src');
    return {
      id: 'read_file',
      description: 'Read a previously written file back. Path is relative to src/.',
      inputSchema: z.object({ path: z.string() }),
      outputSchema: z.object({ content: z.string() }),
      execute: async ({ context }: { context: { path: string } }) => {
        const { readFile } = await import('node:fs/promises');
        const resolved = resolveScopedPath(srcRoot, context.path);
        const content = await readFile(resolved, 'utf-8');
        return { content };
      },
    };
  }

  private async compileCheck(productDir: string): Promise<{ ok: boolean; output: string }> {
    try {
      // `products/<id>/` sits inside this repo, nested under the root pnpm-workspace.yaml -
      // without --ignore-workspace, pnpm walks up, finds that workspace root, and either
      // refuses to install (the directory isn't in `packages:`) or writes into the *repo's*
      // lockfile/store instead of treating this as the standalone project it actually is.
      const { stdout, stderr } = await execAsync('pnpm install --ignore-workspace && npx tsc --noEmit', { cwd: productDir });
      return { ok: true, output: stdout + stderr };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message: string };
      return { ok: false, output: (e.stdout ?? '') + (e.stderr ?? '') || e.message };
    }
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
