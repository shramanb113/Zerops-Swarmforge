import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CoderLanguageProfile } from './shared.js';

const execAsync = promisify(exec);

const PACKAGE_JSON = (name: string) => JSON.stringify(
  {
    name,
    version: '0.1.0',
    private: true,
    type: 'module',
    scripts: { build: 'tsc -p tsconfig.json', start: 'node dist/index.js' },
    dependencies: { fastify: '^5.1.0' },
    devDependencies: { typescript: '^5.6.3', '@types/node': '^22.10.0' },
  },
  null,
  2,
);

const TSCONFIG_JSON = JSON.stringify(
  {
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      lib: ['ES2022'],
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      outDir: 'dist',
      rootDir: 'src',
    },
    include: ['src/**/*.ts'],
  },
  null,
  2,
);

export const typescriptProfile: CoderLanguageProfile = {
  entrypointFilename: 'index.ts',

  async scaffold(productDir, name) {
    await mkdir(path.join(productDir, 'src'), { recursive: true });
    await writeFile(path.join(productDir, 'package.json'), PACKAGE_JSON(name), 'utf-8');
    await writeFile(path.join(productDir, 'tsconfig.json'), TSCONFIG_JSON, 'utf-8');
  },

  instructions() {
    return 'You implement one Node.js/TypeScript Fastify service. Write ' +
      'code ONLY by calling the write_file tool - never put source code in your text reply.\n' +
      'PATHS: the `path` argument is always relative to the service\'s src/ directory, which ' +
      'already exists. The entrypoint is therefore exactly "index.ts" - never "src/index.ts", ' +
      'never an absolute path, never a path containing "..".\n' +
      'Strongly prefer ONE self-contained backend file, "index.ts": a Fastify server that ' +
      'listens on Number(process.env.PORT ?? 3000) with host "0.0.0.0" and implements every ' +
      'endpoint from the proposal. Only split into more .ts files if you truly cannot avoid it.\n' +
      'The project compiles with `tsc --noEmit` under "strict": true and "moduleResolution": ' +
      '"NodeNext", so every relative import between your own .ts files MUST carry an explicit ' +
      '".js" extension (e.g. import { x } from "./routes.js").\n' +
      'Also add a GET "/" route returning the contents of "frontend.html", which sits next to ' +
      'this file, as text/html - read it with ' +
      'readFileSync(path.join(process.cwd(), "src", "frontend.html"), "utf-8") (import both ' +
      '"node:fs" and "node:path") rather than a path built from import.meta.url, since the ' +
      'compiled file runs from dist/ but this always runs from the service\'s own working ' +
      "directory. This is what makes the UI reachable at the deployed service's own root " +
      'URL.\n' +
      'Only "fastify" and "@types/node" are installed - do not import any other package.\n' +
      'Do not write package.json or tsconfig.json; they already exist.\n';
  },

  async compileCheck(productDir) {
    try {
      const { stdout, stderr } = await execAsync('pnpm install --ignore-workspace && npx tsc --noEmit', {
        cwd: productDir,
        timeout: 180_000,
        maxBuffer: 10 * 1024 * 1024,
      });
      return { ok: true, output: stdout + stderr };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message: string };
      return { ok: false, output: (e.stdout ?? '') + (e.stderr ?? '') || e.message };
    }
  },
};
