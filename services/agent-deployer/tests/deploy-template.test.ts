import { describe, it, expect } from 'vitest';
import { renderZeropsYaml, renderServiceImportYaml } from '../src/deploy-template.js';

describe('renderZeropsYaml', () => {
  it('renders the TypeScript base image and build commands unchanged', () => {
    const yaml = renderZeropsYaml('hello-api', 'typescript');
    expect(yaml).toContain('ubuntu/nodejs@22');
    expect(yaml).toContain('pnpm build');
    expect(yaml).toContain('node dist/index.js');
  });

  it('renders the Python base image and build commands', () => {
    const yaml = renderZeropsYaml('hello-api', 'python');
    expect(yaml).toContain('ubuntu/python@3.12');
    expect(yaml).toContain('pip install -r requirements.txt');
    expect(yaml).toContain('python src/main.py');
  });
});

describe('renderServiceImportYaml', () => {
  it('uses the matching base image type per language', () => {
    expect(renderServiceImportYaml('hello-api', 'typescript')).toContain('ubuntu/nodejs@22');
    expect(renderServiceImportYaml('hello-api', 'python')).toContain('ubuntu/python@3.12');
  });
});
