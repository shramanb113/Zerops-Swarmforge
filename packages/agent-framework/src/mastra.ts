import path from 'node:path';
import { Agent } from '@mastra/core/agent';
import type { MastraStorage } from '@mastra/core/storage';
import { Memory } from '@mastra/memory';
import { PostgresStore } from '@mastra/pg';
import { createGroq } from '@ai-sdk/groq';

const DEFAULT_MODEL_ID = 'llama-3.3-70b-versatile';

/**
 * Builds the default Groq-backed model lazily. `createGroq(...)(...)` only constructs a
 * `LanguageModelV1`-shaped object — it makes no network call until something actually invokes
 * `.doGenerate()` — so this is safe to call even when `GROQ_API_KEY` is unset (e.g. in tests
 * that always pass an explicit mock model via `opts.model` and never reach this function).
 */
function defaultModel() {
  return createGroq({ apiKey: process.env.GROQ_API_KEY })(DEFAULT_MODEL_ID);
}

// Derived from the Agent constructor's own parameter type instead of importing a named
// Mastra type directly — sidesteps needing to know the exact exported type name, which may
// have moved between Mastra versions.
type AgentCtorOptions = ConstructorParameters<typeof Agent>[0];

export interface CreateAgentOptions {
  /**
   * Caller-only bookkeeping id (e.g. for logging/registry lookups). Mastra's `AgentConfig` has
   * no `id` field of its own — `Agent#id` is derived from `name` at the class level — so this
   * is accepted here but never forwarded to the `Agent` constructor.
   */
  id?: string;
  name: string;
  instructions: string;
  /** A real AI-SDK `LanguageModelV1`-shaped model (e.g. from `@ai-sdk/groq`), or a mock/test model. */
  model?: AgentCtorOptions['model'];
  tools?: AgentCtorOptions['tools'];
  databaseUrl: string;
}

export function createAgent(opts: CreateAgentOptions): Agent {
  return new Agent({
    name: opts.name,
    instructions: opts.instructions,
    model: opts.model ?? defaultModel(),
    tools: opts.tools,
    memory: new Memory({
      // Type-only workaround for a real version-skew bug between the two pinned Mastra
      // packages: @mastra/core@0.10.15's `MastraStorage` abstract class declares
      // `supports: { selectByIncludeResourceScope: boolean; resourceWorkingMemory: boolean }`,
      // but @mastra/pg@0.10.3's `PostgresStore.supports` getter still only returns
      // `{ selectByIncludeResourceScope: boolean }` (confirmed in both packages' installed
      // .d.ts files — there is no newer 0.10.x patch of either package that reconciles this).
      // `PostgresStore` is otherwise a fully functional `MastraStorage` at runtime; only the
      // capability-detection getter's declared type is stale.
      storage: new PostgresStore({ connectionString: opts.databaseUrl }) as unknown as MastraStorage,
    }),
  });
}

/**
 * Deterministic name sanitizer. Any name that reaches a filesystem path, shell argument, or
 * Zerops hostname must go through this first — never trust LLM output to already be safe,
 * even when the prompt/schema asked for a slug.
 */
export function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
  return slug || 'product';
}

/**
 * Resolves `relativePath` against `root` and throws if the result would land outside `root`.
 * Used to guard any tool whose path argument is LLM-controlled.
 */
export function resolveScopedPath(root: string, relativePath: string): string {
  const rootResolved = path.resolve(root);
  const resolved = path.resolve(root, relativePath);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
    throw new Error(`path "${relativePath}" escapes the allowed directory "${root}"`);
  }
  return resolved;
}
