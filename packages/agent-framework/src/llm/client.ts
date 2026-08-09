export interface LLMClient {
  complete(prompt: string, opts?: { maxTokens?: number; temperature?: number }): Promise<string>;
}
