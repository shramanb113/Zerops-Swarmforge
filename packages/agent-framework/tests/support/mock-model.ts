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

export interface MockModelResponse {
  text?: string;
  /** JSON-stringified structured output, for agents using structuredOutput */
  object?: unknown;
  /**
   * If set, the mock emits these tool-call(s) on its first call, then a plain text response
   * on every subsequent call. Needed for any agent that must actually exercise a tool's
   * `execute()` (Coder, Deployer) - a text-only mock never triggers a tool call, so a tool's
   * side effects (writing a file, etc.) silently never happen and any test asserting on them
   * would be exercising nothing.
   */
  toolCalls?: ScriptedToolCall[];
}

export function createMockModel(response: MockModelResponse): MockLanguageModelV1 {
  const finalText = response.object !== undefined ? JSON.stringify(response.object) : (response.text ?? 'done');
  let callCount = 0;
  return new MockLanguageModelV1({
    doGenerate: async () => {
      callCount += 1;
      if (response.toolCalls && response.toolCalls.length > 0 && callCount === 1) {
        return {
          finishReason: 'tool-calls',
          usage: { promptTokens: 0, completionTokens: 0 },
          toolCalls: response.toolCalls.map((call, i) => ({
            toolCallType: 'function' as const,
            toolCallId: `mock-call-${i}`,
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
        text: finalText,
        rawCall: { rawPrompt: null, rawSettings: {} },
        warnings: [],
      };
    },
  });
}
