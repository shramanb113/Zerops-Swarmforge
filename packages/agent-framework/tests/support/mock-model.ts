import { MockLanguageModelV1 } from 'ai/test';

/**
 * NOTE on deviations from the original task brief (Task 1 spike findings):
 *
 * The installed `ai` package is v4.3.19, which implements the AI SDK's *v1* provider
 * specification, not v2. `ai/test` exports `MockLanguageModelV1` (there is no
 * `MockLanguageModelV2` in this version). This matches what `@mastra/core@0.10.15` itself
 * expects: its `MastraLanguageModel` type is a direct alias for `LanguageModelV1` from
 * `@ai-sdk/provider` (confirmed in `@mastra/core/dist/base-5ZyKaTRr.d.ts`), and Mastra's own
 * internal `createMockModel` helper (not used here, we build our own) also returns a
 * `MockLanguageModelV1`.
 *
 * `LanguageModelV1['doGenerate']`'s resolved value shape is materially different from the
 * v2 `content`-array shape described in the brief:
 *   - no `content` array; instead a flat `text?: string` field plus a separate `toolCalls?`
 *     array.
 *   - tool calls are `{ toolCallType: 'function', toolCallId, toolName, args }` where `args`
 *     is a JSON-stringified string (not `input`).
 *   - `usage` is `{ promptTokens, completionTokens }` (not `inputTokens`/`outputTokens`/`totalTokens`).
 *   - `rawCall: { rawPrompt, rawSettings }` is a *required* field (not present at all in the
 *     brief's sample).
 * All of this was cross-checked against `node_modules/ai/test/dist/index.d.ts` and
 * `node_modules/@ai-sdk/provider/dist/index.d.ts`.
 */

export interface ScriptedToolCall {
  /** Must match the key this tool is registered under in the Agent's `tools` map, not just its `id`. */
  toolName: string;
  input: unknown;
}

/**
 * One `agent.generate()` call's worth of scripted model behavior. If `toolCalls` is set, the
 * mock emits all of them in a single response (matching how a real model can request several
 * tool calls at once — see the Deployer's three-tool-call round), then a follow-up text
 * response (`text`, default `'done'`) once Mastra's agent loop asks for the turn's final text
 * after executing them. If `toolCalls` is omitted, the round is just the text response.
 */
export interface MockModelRound {
  toolCalls?: ScriptedToolCall[];
  text?: string;
}

export interface MockModelResponse {
  text?: string;
  /** JSON-stringified structured output, for agents using structuredOutput */
  object?: unknown;
  /**
   * If set, the mock emits these tool-call(s) on its first call, then a plain text response
   * on every subsequent call. Needed for any agent that must actually exercise a tool's
   * `execute()` (Coder, Deployer) - a text-only mock never triggers a tool call, so a tool's
   * side effects (writing a file, etc.) silently never happen and any test asserting on them
   * would be exercising nothing. Equivalent to `rounds: [{ toolCalls }]` below - kept as its
   * own field since every existing caller uses this single-round shorthand.
   */
  toolCalls?: ScriptedToolCall[];
  /**
   * Scripts a *different* response for each successive `agent.generate()` call - needed to
   * test a retry loop, where attempt 1 must fail a check and attempt 2 must pass it. Each
   * element is one `generate()` call's worth of behavior (see `MockModelRound`). Once every
   * round has been consumed, further calls keep repeating the last round's response rather
   * than erroring. Mutually exclusive with `text`/`object`/`toolCalls` above - when `rounds`
   * is set, those three are ignored.
   */
  rounds?: MockModelRound[];
}

type Step =
  | { kind: 'toolCalls'; calls: ScriptedToolCall[] }
  | { kind: 'text'; text: string };

function expandRounds(rounds: MockModelRound[]): Step[] {
  const steps: Step[] = [];
  for (const round of rounds) {
    if (round.toolCalls && round.toolCalls.length > 0) {
      steps.push({ kind: 'toolCalls', calls: round.toolCalls });
    }
    steps.push({ kind: 'text', text: round.text ?? 'done' });
  }
  return steps;
}

export function createMockModel(response: MockModelResponse): MockLanguageModelV1 {
  const steps = response.rounds && response.rounds.length > 0
    ? expandRounds(response.rounds)
    : expandRounds([{
        toolCalls: response.toolCalls,
        text: response.object !== undefined ? JSON.stringify(response.object) : (response.text ?? 'done'),
      }]);
  let stepIndex = 0;

  return new MockLanguageModelV1({
    // Only set for structured-output responses: `agent.generate(prompt, { output: schema })`
    // calls the AI SDK's `generateObject()`, which throws "Model does not have a default
    // object generation mode" unless the model declares one. 'json' matches how this mock
    // returns its structured payload — as a JSON-stringified `text`, not a tool call.
    defaultObjectGenerationMode: response.object !== undefined ? 'json' : undefined,
    doGenerate: async () => {
      // Steps beyond the scripted ones keep repeating the last step, matching the pre-`rounds`
      // behavior of "plain text forever" once past round 1 - a caller that doesn't care about
      // calls past the ones it scripted doesn't need to reason about it.
      const step = steps[Math.min(stepIndex, steps.length - 1)];
      stepIndex += 1;
      if (step.kind === 'toolCalls') {
        return {
          finishReason: 'tool-calls',
          usage: { promptTokens: 0, completionTokens: 0 },
          toolCalls: step.calls.map((call, i) => ({
            toolCallType: 'function' as const,
            toolCallId: `mock-call-${stepIndex}-${i}`,
            toolName: call.toolName,
            args: JSON.stringify(call.input),
          })),
          rawCall: { rawPrompt: null, rawSettings: {} },
          warnings: [],
        };
      }
      return {
        finishReason: 'stop',
        usage: { promptTokens: 0, completionTokens: 0 },
        text: step.text,
        rawCall: { rawPrompt: null, rawSettings: {} },
        warnings: [],
      };
    },
  });
}
