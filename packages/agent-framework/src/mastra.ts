import path from 'node:path';
import { Agent } from '@mastra/core/agent';
import { createGroq } from '@ai-sdk/groq';

/**
 * Default Groq model for every agent.
 *
 * NOT `llama-3.3-70b-versatile` (the model the design spec originally named): on Groq, the
 * Llama 3.x models do not emit native structured tool calls. They emit a text-format call —
 * `<function=write_file>{"path": ..., "content": ...}</function>` — that Groq's API then
 * re-parses server-side as JSON. Whenever a tool argument carries a blob of generated source
 * code, that source routinely contains sequences that are valid in the target language but
 * invalid inside a JSON string (most commonly a JS-escaped apostrophe, `\'`), the server-side
 * re-parse fails, and the whole request comes back as HTTP 400
 * `tool_use_failed: "Failed to call a function. Please adjust your prompt."`. Measured against
 * the Coder's real tool schema and prompt, llama-3.3-70b-versatile failed 2 of 3 runs this way;
 * `openai/gpt-oss-120b`, which emits real structured tool calls, succeeded 8 of 8 (and 3 of 3
 * on both the Architect's structured-output call and the Deployer's tool sequence).
 *
 * Overridable via `GROQ_MODEL` so a deployment can move to another Groq model without a code
 * change — but any replacement must support native tool calling, not the Llama text format.
 */
const DEFAULT_MODEL_ID = 'openai/gpt-oss-120b';

/**
 * Builds the default Groq-backed model lazily. `createGroq(...)(...)` only constructs a
 * `LanguageModelV1`-shaped object — it makes no network call until something actually invokes
 * `.doGenerate()` — so this is safe to call even when `GROQ_API_KEY` is unset (e.g. in tests
 * that always pass an explicit mock model via `opts.model` and never reach this function).
 */
function defaultModel() {
  return createGroq({ apiKey: process.env.GROQ_API_KEY })(process.env.GROQ_MODEL || DEFAULT_MODEL_ID);
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
}

/**
 * Builds a stateless Mastra `Agent`.
 *
 * Deliberately has **no `memory`**. An earlier revision attached
 * `new Memory({ storage: new PostgresStore(...) })` here, which constructed a fresh
 * `pg-promise` connection pool on *every* `createAgent()` call — i.e. once per task — and
 * never disconnected it, leaking connections for the lifetime of each agent process. It also
 * bought nothing: Mastra only persists a thread when `generate()` is given a
 * `threadId`/`resourceId`, no caller here ever passes either, and a live database inspection
 * confirmed no `mastra_*` table was ever created. Each task is a single self-contained
 * `generate()` call, so there is no conversation to remember. If cross-task memory is ever
 * genuinely needed, add it with one shared, explicitly disposed store — not one per call.
 */
export function createAgent(opts: CreateAgentOptions): Agent {
  return new Agent({
    name: opts.name,
    instructions: opts.instructions,
    model: opts.model ?? defaultModel(),
    tools: opts.tools,
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
