import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { createAgent, slugify, resolveScopedPath } from '../src/mastra.js';
import { createMockModel } from './support/mock-model.js';

describe('slugify', () => {
  it('lowercases, replaces non-alphanumerics with hyphens, and trims', () => {
    expect(slugify('Todo App!!')).toBe('todo-app');
    expect(slugify('  --Weird__Name--  ')).toBe('weird-name');
  });

  it('falls back to "product" for an empty result', () => {
    expect(slugify('!!!')).toBe('product');
  });
});

describe('resolveScopedPath', () => {
  // Built via path.resolve() rather than a hardcoded POSIX literal ('/tmp/root') so the
  // assertion holds on Windows too, where path.resolve('/tmp/root') resolves against the
  // current drive (e.g. 'D:\tmp\root'), not the literal string '/tmp/root'.
  const root = path.resolve(path.sep, 'tmp', 'root');

  it('resolves a path inside the root', () => {
    const resolved = resolveScopedPath(root, 'src/index.ts');
    expect(resolved.startsWith(root)).toBe(true);
  });

  it('rejects a path that escapes the root', () => {
    expect(() => resolveScopedPath(root, '../../etc/passwd')).toThrow(/escapes/);
  });
});

describe('createAgent', () => {
  it('constructs a Mastra Agent usable with a mock model', async () => {
    const agent = createAgent({
      id: 'test-agent',
      name: 'Test Agent',
      instructions: 'test',
      model: createMockModel({ text: 'ok' }),
    });
    const response = await agent.generate('hi');
    expect(response.text).toBe('ok');
  });
});
