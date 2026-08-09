import { describe, it, expect } from 'vitest';
import { checkFrontendSyntax, extractScriptBodies } from '../src/frontend-syntax-check.js';

describe('extractScriptBodies', () => {
  it('extracts the body of an inline <script> tag', () => {
    const html = '<html><body><script>const x = 1;</script></body></html>';
    expect(extractScriptBodies(html)).toEqual(['const x = 1;']);
  });

  it('extracts multiple inline <script> tags', () => {
    const html = '<script>const a = 1;</script><script>const b = 2;</script>';
    expect(extractScriptBodies(html)).toEqual(['const a = 1;', 'const b = 2;']);
  });

  it('ignores a <script src="..."> tag with no inline body', () => {
    const html = '<script src="https://example.com/lib.js"></script><script>const a = 1;</script>';
    expect(extractScriptBodies(html)).toEqual(['const a = 1;']);
  });

  it('returns an empty array when there is no <script> tag', () => {
    expect(extractScriptBodies('<html><body>hi</body></html>')).toEqual([]);
  });
});

describe('checkFrontendSyntax', () => {
  it('passes when there is no frontend.html in the file list yet', () => {
    const result = checkFrontendSyntax([{ path: 'index.ts', content: 'export {}' }]);
    expect(result.ok).toBe(true);
  });

  it('passes valid modern JavaScript (no false positives)', () => {
    const html = `<script>
      const greet = async (name) => {
        const { length } = name;
        return \`hello \${name}, length \${length}\`;
      };
    </script>`;
    const result = checkFrontendSyntax([{ path: 'frontend.html', content: html }]);
    expect(result.ok).toBe(true);
  });

  it('fails on a TypeScript "as" cast', () => {
    const html = '<script>const x = 5 as number; document.title = String(x);</script>';
    const result = checkFrontendSyntax([{ path: 'frontend.html', content: html }]);
    expect(result.ok).toBe(false);
  });

  it('fails on a TypeScript variable type annotation', () => {
    const html = '<script>let x: number = 5; document.title = String(x);</script>';
    const result = checkFrontendSyntax([{ path: 'frontend.html', content: html }]);
    expect(result.ok).toBe(false);
  });

  it('fails when any one of multiple <script> blocks is invalid', () => {
    const html = '<script>const ok = 1;</script><script>const bad = 2 as number;</script>';
    const result = checkFrontendSyntax([{ path: 'frontend.html', content: html }]);
    expect(result.ok).toBe(false);
  });

  it('checks only the latest frontend.html entry when the file was written more than once', () => {
    const bad = '<script>const x = 1 as number;</script>';
    const good = '<script>const x = 1;</script>';
    const result = checkFrontendSyntax([
      { path: 'frontend.html', content: bad },
      { path: 'frontend.html', content: good },
    ]);
    expect(result.ok).toBe(true);
  });
});
