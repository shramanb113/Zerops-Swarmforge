import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  ZeropsAgent, type ZeropsAgentDeps, createAgent, resolveScopedPath, slugify,
  products, architectureProposals, taskEvents, and, eq,
} from '@swarmforge/agent-framework';
import { scaffoldProduct } from './product-template.js';
import { checkFrontendSyntax } from './frontend-syntax-check.js';

const execAsync = promisify(exec);

const TaskPayload = z.object({ productId: z.string().uuid(), proposalId: z.string().uuid() });

// `process.cwd()` varies by invocation (a service's own directory when run via `pnpm --filter
// X dev`, but the repo root when the same code runs inside vitest via the root `test` script) -
// resolving relative to import.meta.url is stable regardless of how/where the process started.
const PRODUCTS_ROOT = fileURLToPath(new URL('../../../products', import.meta.url));

type CoderDeps = Omit<ZeropsAgentDeps, 'role'> & {
  model?: Parameters<typeof createAgent>[0]['model'];
  controlPlaneUrl?: string;
};

type CheckResult = { ok: true } | { ok: false; stage: 'frontend-syntax' | 'backend-tsc'; output: string };

export class CoderAgent extends ZeropsAgent {
  private readonly controlPlaneUrl: string;
  private readonly agentModel: Parameters<typeof createAgent>[0]['model'];

  constructor(deps: CoderDeps) {
    super({ ...deps, role: 'coder' });
    this.agentModel = deps.model;
    this.controlPlaneUrl = deps.controlPlaneUrl ?? process.env.CONTROL_PLANE_URL ?? 'http://localhost:3000';
  }

  async onTask(payload: unknown): Promise<void> {
    const { productId } = TaskPayload.parse(payload);
    const taskId = this.currentTaskId!;

    // Idempotency guard, mirroring ArchitectAgent's: NATS redelivers this exact task on any
    // thrown error (e.g. a transient control-plane blip on the handoff POST below), up to
    // maxDeliver attempts. Without this check every redelivery re-runs the whole LLM
    // generation and a fresh `pnpm install`/`tsc` round-trip from scratch - observed live as
    // five duplicate runs of a single task. If a `code_generated` event already exists for
    // this task, the code is already on disk and already compiled; only the handoff is left.
    const [existingCodeGenerated] = await this.db
      .select()
      .from(taskEvents)
      .where(and(eq(taskEvents.taskId, taskId), eq(taskEvents.eventType, 'code_generated')));

    if (!existingCodeGenerated) {
      await this.generateAndCompile(productId, taskId);
    }

    const res = await fetch(`${this.controlPlaneUrl}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'build-product', role: 'deployer', payload: { productId } }),
    });
    if (!res.ok) {
      throw new Error(`failed to hand off to deployer: POST /tasks returned ${res.status}`);
    }
  }

  private async generateAndCompile(productId: string, taskId: string): Promise<void> {
    const [product] = await this.db.select().from(products).where(eq(products.id, productId));
    if (!product) throw new Error(`product ${productId} not found`);
    const [proposal] = await this.db
      .select()
      .from(architectureProposals)
      .where(eq(architectureProposals.productId, productId));
    if (!proposal) throw new Error(`no architecture proposal found for product ${productId}`);

    const productDir = path.join(PRODUCTS_ROOT, productId);
    // Re-slugify at the point of use rather than trusting that whoever wrote this row already
    // did. `name` ends up as the generated package.json's `name` field; the global constraint
    // is that any name reaching a filesystem path, shell argument or Zerops hostname is
    // slugify() output, and that must hold as an invariant, not as a convention that happens
    // to be true because ArchitectAgent is currently the only writer. slugify is idempotent.
    await scaffoldProduct(productDir, slugify(product.name));

    const writtenFiles: Array<{ path: string; content: string }> = [];
    const writeFileTool = this.buildWriteFileTool(productDir, writtenFiles);
    const readFileTool = this.buildReadFileTool(productDir);

    const agent = createAgent({
      id: 'coder',
      name: 'Coder',
      instructions:
        'You implement one Node.js/TypeScript Fastify service AND its companion frontend. Write ' +
        'code ONLY by calling the write_file tool - never put source code in your text reply.\n' +
        'PATHS: the `path` argument is always relative to the service\'s src/ directory, which ' +
        'already exists. The entrypoint is therefore exactly "index.ts" - never "src/index.ts", ' +
        'never an absolute path, never a path containing "..".\n' +
        'Strongly prefer ONE self-contained backend file, "index.ts": a Fastify server that ' +
        'listens on Number(process.env.PORT ?? 3000) with host "0.0.0.0" and implements every ' +
        'endpoint from the proposal. Only split into more .ts files if you truly cannot avoid it.\n' +
        'The project compiles with `tsc --noEmit` under "strict": true and "moduleResolution": ' +
        '"NodeNext", so every relative import between your own .ts files MUST carry an explicit ' +
        '".js" extension (e.g. import { x } from "./routes.js").\n' +
        'Only "fastify" and "@types/node" are installed - do not import any other package.\n' +
        'Do not write package.json or tsconfig.json; they already exist.\n' +
        'ALSO write exactly one more file, "frontend.html" (not under any subfolder): a single ' +
        'self-contained static HTML page - inline <style> and <script>, zero external ' +
        'dependencies, zero build step - implementing the ONE screen described in the proposal\'s ' +
        '"Frontend:" paragraph. It is never checked by tsc and never imports the backend file, so ' +
        'wire it up with realistic inline sample data (const literals) rather than a live fetch() ' +
        'to the backend - it must render meaningfully opened on its own. Design it minimal and ' +
        'clean: generous whitespace, a clear visual hierarchy, restrained color use, no lorem ' +
        'ipsum placeholder text.\n' +
        'The <script> in frontend.html runs directly in the browser with NO transpile step - it ' +
        'is plain JavaScript, NOT TypeScript. Never write TypeScript-only syntax there: no `as ' +
        'SomeType` casts, no `: type` annotations on variables/params/returns, no interfaces. A ' +
        'single such statement throws a SyntaxError that silently kills every event listener in ' +
        'the whole script block, not just that line - this has actually happened, so treat it as ' +
        'a hard rule, not a style preference.',
      model: this.agentModel,
      // Keys must match the toolName a tool-call refers to - the map key is the tool's public
      // name from the model's perspective, not the local variable name it's assigned from.
      tools: { write_file: writeFileTool, read_file: readFileTool },
    });

    await agent.generate(
      `Architecture proposal for "${proposal.serviceName}": ${proposal.summary}\n` +
        `Endpoints: ${JSON.stringify(proposal.endpoints)}\n` +
        `Data model: ${JSON.stringify(proposal.dataModel)}\n` +
        'Implement this now: call write_file for "index.ts" (the backend) and again for ' +
        '"frontend.html" (the UI) - both are required.',
    );

    await this.db.update(products).set({ status: 'coding', updatedAt: new Date() }).where(eq(products.id, productId));

    const attempts: Array<{ stage: 'frontend-syntax' | 'backend-tsc'; output: string }> = [];
    let check = await this.runChecks(productDir, writtenFiles);
    if (!check.ok) {
      attempts.push({ stage: check.stage, output: check.output });
      const checkName = check.stage === 'frontend-syntax'
        ? 'frontend.html <script> syntax check'
        : 'backend `tsc --noEmit` compile check';
      await agent.generate(
        `Your previous attempt failed the ${checkName}:\n\n${check.output}\n\n` +
          'Fix this now by calling write_file again for the affected file with corrected content.',
      );
      check = await this.runChecks(productDir, writtenFiles);
      if (!check.ok) attempts.push({ stage: check.stage, output: check.output });
    }

    if (!check.ok) {
      await this.db.update(products).set({ status: 'failed', updatedAt: new Date() }).where(eq(products.id, productId));
      await this.db.insert(taskEvents).values({
        taskId,
        role: 'coder',
        eventType: 'compile_failed',
        payload: { stage: check.stage, output: check.output, attempts },
      });
      throw new Error(`generated product ${productId} failed to compile:\n${check.output}`);
    }

    await this.db.insert(taskEvents).values({
      taskId,
      role: 'coder',
      eventType: 'code_generated',
      payload: { files: dedupeByPath(writtenFiles) },
    });
  }

  private async runChecks(
    productDir: string,
    writtenFiles: Array<{ path: string; content: string }>,
  ): Promise<CheckResult> {
    const frontendResult = checkFrontendSyntax(writtenFiles);
    if (!frontendResult.ok) return { ok: false, stage: 'frontend-syntax', output: frontendResult.output };

    const compileResult = await this.compileCheck(productDir);
    if (!compileResult.ok) return { ok: false, stage: 'backend-tsc', output: compileResult.output };

    return { ok: true };
  }

  private buildWriteFileTool(productDir: string, writtenFiles: Array<{ path: string; content: string }>) {
    const srcRoot = path.join(productDir, 'src');
    return {
      id: 'write_file',
      description:
        'Write a source file. `path` is relative to the service\'s src/ directory and must NOT ' +
        'start with "src/" - the entrypoint is "index.ts", not "src/index.ts".',
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      outputSchema: z.object({ written: z.boolean() }),
      execute: async ({ context }: { context: { path: string; content: string } }) => {
        const { writeFile, mkdir } = await import('node:fs/promises');
        const relative = normalizeSrcRelativePath(context.path);
        const resolved = resolveScopedPath(srcRoot, relative);
        await mkdir(path.dirname(resolved), { recursive: true });
        await writeFile(resolved, context.content, 'utf-8');
        // Record where the file actually landed, not the raw LLM-supplied string: those two
        // differ whenever the model prefixes "src/" (or uses backslashes), and a `code_generated`
        // event listing paths that don't exist on disk is worse than useless to anything
        // downstream that tries to read them back. Content is captured here (what was actually
        // written) rather than re-read from disk later, so the dashboard's code viewer has exact
        // parity with what got compiled.
        writtenFiles.push({ path: path.relative(srcRoot, resolved).split(path.sep).join('/'), content: context.content });
        return { written: true };
      },
    };
  }

  private buildReadFileTool(productDir: string) {
    const srcRoot = path.join(productDir, 'src');
    return {
      id: 'read_file',
      description:
        'Read a previously written source file back. `path` is relative to the service\'s src/ ' +
        'directory and must NOT start with "src/", exactly as for write_file.',
      inputSchema: z.object({ path: z.string() }),
      outputSchema: z.object({ content: z.string() }),
      execute: async ({ context }: { context: { path: string } }) => {
        const { readFile } = await import('node:fs/promises');
        const resolved = resolveScopedPath(srcRoot, normalizeSrcRelativePath(context.path));
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
      // timeout/maxBuffer are not optional niceties here: this shells out to a real network
      // install plus a compiler, both driven by LLM-authored input. Without `timeout` a hung
      // registry request would wedge the consumer forever (the task is never acked or nacked);
      // without `maxBuffer` a verbose install/compile that exceeds Node's 1 MB default kills
      // the child with ENOBUFS and reports it as a compile failure.
      const { stdout, stderr } = await execAsync('pnpm install --ignore-workspace && npx tsc --noEmit', {
        cwd: productDir,
        timeout: 180_000,
        maxBuffer: 10 * 1024 * 1024,
      });
      return { ok: true, output: stdout + stderr };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message: string };
      return { ok: false, output: (e.stdout ?? '') + (e.stderr ?? '') || e.message };
    }
  }
}

/**
 * Normalizes an LLM-supplied path into one that is genuinely relative to `src/`.
 *
 * The tool contract is "relative to src/", but a model that has been told the project lives in
 * src/ will sometimes hand back "src/index.ts" anyway - which, resolved against srcRoot,
 * silently produced `src/src/index.ts` on disk (observed live alongside a correct
 * `src/index.ts`). Stripping the redundant prefix here makes the contract enforced rather than
 * merely stated. Backslashes are normalized first so a Windows-style path can't sneak past the
 * prefix check. Traversal is still rejected downstream by `resolveScopedPath`.
 */
function normalizeSrcRelativePath(inputPath: string): string {
  const unix = inputPath.replace(/\\/g, '/').replace(/^\.\//, '');
  return unix.replace(/^\/?src\//, '');
}

/**
 * Collapses `writtenFiles` to the latest content per path. A retry attempt calls `write_file`
 * again for whichever file failed a check, appending a second entry for the same path rather
 * than replacing the first - without this, `code_generated` would report two versions of the
 * same file, and the dashboard's file tree/preview would show the pre-fix (broken) content.
 */
export function dedupeByPath(
  files: Array<{ path: string; content: string }>,
): Array<{ path: string; content: string }> {
  const latest = new Map<string, string>();
  for (const file of files) latest.set(file.path, file.content);
  return [...latest.entries()].map(([path, content]) => ({ path, content }));
}
