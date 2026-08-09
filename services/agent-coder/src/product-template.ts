import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const PRODUCT_PACKAGE_JSON = (name: string) => JSON.stringify(
  {
    name,
    version: '0.1.0',
    private: true,
    type: 'module',
    scripts: { build: 'tsc -p tsconfig.json', start: 'node dist/index.js' },
    dependencies: { fastify: '^5.1.0' },
    // `@types/node` is required for generated code to compile cleanly whenever it touches Node
    // globals (`process`, `Buffer`, etc.) - `process.env.PORT` in the brief's own sample tool
    // call fails `tsc --noEmit` with TS2580 ("Cannot find name 'process'") without it.
    devDependencies: { typescript: '^5.6.3', '@types/node': '^22.10.0' },
  },
  null,
  2,
);

const PRODUCT_TSCONFIG_JSON = JSON.stringify(
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

export async function scaffoldProduct(productDir: string, name: string): Promise<void> {
  await mkdir(path.join(productDir, 'src'), { recursive: true });
  await writeFile(path.join(productDir, 'package.json'), PRODUCT_PACKAGE_JSON(name), 'utf-8');
  await writeFile(path.join(productDir, 'tsconfig.json'), PRODUCT_TSCONFIG_JSON, 'utf-8');
}
