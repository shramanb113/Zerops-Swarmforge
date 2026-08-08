import { describe, it, expect } from 'vitest';
import { Agent } from '@mastra/core/agent';
import { z } from 'zod';
import { createMockModel } from './mock-model.js';

describe('createMockModel', () => {
  it('lets an Agent generate a scripted text response with no network call', async () => {
    const agent = new Agent({
      name: 'mock-test',
      instructions: 'test',
      model: createMockModel({ text: 'hello from the mock' }),
    });

    const response = await agent.generate('anything');
    expect(response.text).toBe('hello from the mock');
  });

  it('drives a real tool call end to end (the mechanism Tasks 6 and 7 depend on)', async () => {
    let receivedInput: unknown;
    const noteTool = {
      id: 'take_note',
      description: 'Records a note.',
      inputSchema: z.object({ note: z.string() }),
      outputSchema: z.object({ recorded: z.boolean() }),
      execute: async ({ context }: { context: { note: string } }) => {
        receivedInput = context;
        return { recorded: true };
      },
    };

    const agent = new Agent({
      name: 'tool-mock-test',
      instructions: 'test',
      model: createMockModel({ toolCalls: [{ toolName: 'take_note', input: { note: 'hi' } }] }),
      tools: { take_note: noteTool },
    });

    await agent.generate('anything');
    expect(receivedInput).toEqual({ note: 'hi' });
  });
});
