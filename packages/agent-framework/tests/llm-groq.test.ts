import { describe, it, expect, vi, beforeEach } from 'vitest';

const create = vi.fn();
vi.mock('groq-sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    chat: { completions: { create } },
  })),
}));

import { GroqClient } from '../src/llm/groq';

describe('GroqClient', () => {
  beforeEach(() => {
    create.mockReset();
  });

  it('sends the prompt as a user message and returns the response content', async () => {
    create.mockResolvedValue({ choices: [{ message: { content: 'hello from groq' } }] });

    const client = new GroqClient('test-key');
    const result = await client.complete('say hi');

    expect(result).toBe('hello from groq');
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [{ role: 'user', content: 'say hi' }],
      }),
    );
  });

  it('throws when Groq returns no content', async () => {
    create.mockResolvedValue({ choices: [{ message: {} }] });
    const client = new GroqClient('test-key');
    await expect(client.complete('say hi')).rejects.toThrow('no content');
  });
});
