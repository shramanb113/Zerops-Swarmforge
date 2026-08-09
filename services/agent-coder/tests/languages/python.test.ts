import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pythonProfile } from '../../src/languages/python.js';

describe('pythonProfile', () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('scaffolds requirements.txt with fastapi and uvicorn pinned', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'python-profile-'));
    await pythonProfile.scaffold(dir, 'hello-api');

    const requirements = await readFile(path.join(dir, 'requirements.txt'), 'utf-8');
    expect(requirements).toContain('fastapi');
    expect(requirements).toContain('uvicorn');
  });

  it('passes compileCheck on a valid FastAPI app', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'python-profile-'));
    await pythonProfile.scaffold(dir, 'hello-api');
    await mkdir(path.join(dir, 'src'), { recursive: true });
    await writeFile(
      path.join(dir, 'src', 'main.py'),
      "import os\n" +
        "import uvicorn\n" +
        "from fastapi import FastAPI\n\n" +
        "app = FastAPI()\n\n" +
        "@app.get('/hello')\n" +
        "def hello():\n" +
        "    return {'message': 'hello'}\n\n" +
        "if __name__ == '__main__':\n" +
        "    uvicorn.run(app, host='0.0.0.0', port=int(os.environ.get('PORT', 3000)))\n",
      'utf-8',
    );

    const result = await pythonProfile.compileCheck(dir);
    expect(result.ok).toBe(true);
  }, 120_000);

  it('fails compileCheck on a syntax error', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'python-profile-'));
    await pythonProfile.scaffold(dir, 'hello-api');
    await mkdir(path.join(dir, 'src'), { recursive: true });
    await writeFile(path.join(dir, 'src', 'main.py'), "def broken(:\n    pass\n", 'utf-8');

    const result = await pythonProfile.compileCheck(dir);
    expect(result.ok).toBe(false);
    expect(result.output.length).toBeGreaterThan(0);
  }, 120_000);
});
