import Groq from 'groq-sdk';
import type { LLMClient } from './client.js';

export class GroqClient implements LLMClient {
  private readonly client: Groq;
  private readonly model: string;

  constructor(apiKey: string, model = 'llama-3.3-70b-versatile') {
    this.client = new Groq({ apiKey });
    this.model = model;
  }

  async complete(prompt: string, opts?: { maxTokens?: number; temperature?: number }): Promise<string> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: opts?.maxTokens ?? 1024,
      temperature: opts?.temperature ?? 0.7,
    });
    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error('Groq response contained no content');
    return content;
  }
}
