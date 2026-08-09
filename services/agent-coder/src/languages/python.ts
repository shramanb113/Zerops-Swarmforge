import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CoderLanguageProfile } from './shared.js';

const REQUIREMENTS_TXT = 'fastapi>=0.115,<1.0\nuvicorn[standard]>=0.32,<1.0\n';

/**
 * Shared across every product's compileCheck so a pinned-version `pip install` only really
 * downloads anything the first time this process runs it - every later call resolves to
 * already-installed packages. Same `fileURLToPath` pattern as `PRODUCTS_ROOT` in
 * coder-agent.ts - stable regardless of whether this runs via `pnpm --filter X dev` (cwd is
 * the service's own directory) or inside vitest via the root `test` script (cwd is the repo
 * root).
 */
const VENV_CACHE_ROOT = fileURLToPath(new URL('../../../../products/.venv-cache', import.meta.url));

const PYTHON_BIN = process.platform === 'win32' ? 'python' : 'python3';

function venvPython(): string {
  return process.platform === 'win32'
    ? path.join(VENV_CACHE_ROOT, 'Scripts', 'python.exe')
    : path.join(VENV_CACHE_ROOT, 'bin', 'python');
}

function run(command: string, args: string[], opts: { cwd?: string; timeoutMs: number; env?: NodeJS.ProcessEnv }): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: opts.cwd, env: opts.env ?? process.env });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, output: output + '\n[timed out]' });
    }, opts.timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, output });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, output: output + '\n' + err.message });
    });
  });
}

/** Boots `src/main.py` for a bounded window to catch import/runtime errors py_compile can't see. */
function bootSmokeTest(productDir: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(venvPython(), [path.join('src', 'main.py')], {
      cwd: productDir,
      env: { ...process.env, PORT: '39123' },
    });
    let output = '';
    // Set once the window elapses and we intentionally kill a still-healthy server, so the
    // `exit` handler below can tell that apart from a crash-triggered exit and use the
    // Traceback-based verdict instead of the (often nonzero/null on Windows) kill exit code.
    let killedForHealthCheck = false;
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    const timer = setTimeout(() => {
      killedForHealthCheck = true;
      child.kill();
    }, 3000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      // Resolve only once the process has actually exited (not merely once we've asked it to)
      // so its cwd handle on productDir is released before the caller tries to rm() it -
      // resolving right after calling kill() raced that cleanup with an EBUSY on Windows. A
      // small extra grace period is needed on top of `exit` too: Windows (esp. with real-time
      // antivirus scanning the just-touched venv/site-packages files the process had open)
      // can lag briefly after process death before the directory handle is actually released.
      if (killedForHealthCheck) {
        const crashed = output.includes('Traceback');
        setTimeout(() => resolve({ ok: !crashed, output: crashed ? output : '' }), 300);
      } else {
        // Exiting on its own within the window (before we kill it) means it crashed - a
        // healthy uvicorn server blocks until killed.
        resolve({ ok: code === 0, output });
      }
    });
  });
}

export const pythonProfile: CoderLanguageProfile = {
  entrypointFilename: 'main.py',

  async scaffold(productDir) {
    await mkdir(productDir, { recursive: true });
    await writeFile(path.join(productDir, 'requirements.txt'), REQUIREMENTS_TXT, 'utf-8');
  },

  instructions() {
    return 'You implement one Python/FastAPI service. Write code ONLY by calling the ' +
      'write_file tool - never put source code in your text reply.\n' +
      'PATHS: the `path` argument is always relative to the service\'s src/ directory, which ' +
      'already exists. The entrypoint is therefore exactly "main.py" - never "src/main.py".\n' +
      'Write ONE self-contained file, "main.py". Use FastAPI for routing, implementing every ' +
      'endpoint from the proposal. At the bottom, under `if __name__ == "__main__":`, call ' +
      "uvicorn.run(app, host='0.0.0.0', port=int(os.environ.get('PORT', 3000))) directly - do " +
      'not rely on an external `uvicorn main:app` invocation, so the file runs standalone as ' +
      '`python src/main.py` regardless of working directory. Only "fastapi" and "uvicorn" are ' +
      'installed - do not import any other third-party package.\n' +
      'Do not write requirements.txt; it already exists.\n';
  },

  async compileCheck(productDir) {
    const mainPy = path.join(productDir, 'src', 'main.py');

    const syntaxCheck = await run(PYTHON_BIN, ['-m', 'py_compile', mainPy], { timeoutMs: 15_000 });
    if (!syntaxCheck.ok) return { ok: false, output: syntaxCheck.output };

    await mkdir(VENV_CACHE_ROOT, { recursive: true });
    const { existsSync } = await import('node:fs');
    if (!existsSync(venvPython())) {
      const createVenv = await run(PYTHON_BIN, ['-m', 'venv', VENV_CACHE_ROOT], { timeoutMs: 60_000 });
      if (!createVenv.ok) return { ok: false, output: createVenv.output };
    }

    const install = await run(venvPython(), ['-m', 'pip', 'install', '-r', path.join(productDir, 'requirements.txt')], {
      timeoutMs: 100_000,
    });
    if (!install.ok) return { ok: false, output: install.output };

    const boot = await bootSmokeTest(productDir);
    if (!boot.ok) return { ok: false, output: boot.output || 'app failed to boot within 3s' };

    return { ok: true, output: syntaxCheck.output + install.output };
  },
};
