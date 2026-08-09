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

  it('scripts a different tool call on each successive agent.generate() call (rounds)', async () => {
    const received: string[] = [];
    const noteTool = {
      id: 'take_note',
      description: 'Records a note.',
      inputSchema: z.object({ note: z.string() }),
      outputSchema: z.object({ recorded: z.boolean() }),
      execute: async ({ context }: { context: { note: string } }) => {
        received.push(context.note);
        return { recorded: true };
      },
    };

    const agent = new Agent({
      name: 'rounds-mock-test',
      instructions: 'test',
      model: createMockModel({
        rounds: [
          { toolCalls: [{ toolName: 'take_note', input: { note: 'first' } }] },
          { toolCalls: [{ toolName: 'take_note', input: { note: 'second' } }] },
        ],
      }),
      tools: { take_note: noteTool },
    });

    await agent.generate('go');
    await agent.generate('go again');

    expect(received).toEqual(['first', 'second']);
  });

  it('repeats the last scripted round for any call beyond the ones provided', async () => {
    const model = createMockModel({ rounds: [{ text: 'round one' }, { text: 'round two' }] });
    const agent = new Agent({ name: 'rounds-repeat-test', instructions: 'test', model });

    const r1 = await agent.generate('a');
    const r2 = await agent.generate('b');
    const r3 = await agent.generate('c');

    expect([r1.text, r2.text, r3.text]).toEqual(['round one', 'round two', 'round two']);
  });

  it('gracefully handles an empty rounds array by falling back to default text response', async () => {
    const model = createMockModel({ rounds: [] });
    const agent = new Agent({ name: 'empty-rounds-test', instructions: 'test', model });

    const response = await agent.generate('anything');
    expect(response.text).toBe('done');
  });
});
