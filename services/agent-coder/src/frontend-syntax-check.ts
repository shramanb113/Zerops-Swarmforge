/**
 * Extracts the text content of every inline `<script>` tag in an HTML document. A
 * `<script src="...">` tag has no inline body to check, so it's skipped entirely rather than
 * yielding an empty string.
 */
export function extractScriptBodies(html: string): string[] {
  const bodies: string[] = [];
  const scriptTag = /<script(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = scriptTag.exec(html)) !== null) {
    bodies.push(match[1]);
  }
  return bodies;
}

export type FrontendSyntaxCheckResult = { ok: true } | { ok: false; output: string };

/**
 * Syntax-checks every inline <script> in the product's frontend.html without executing any of
 * it. frontend.html runs directly in the browser with no transpile step - it is plain
 * JavaScript, not TypeScript - so a construct like `as SomeType` that would be valid in a .ts
 * file is a SyntaxError there. `new Function(body)` compiles `body` as a function's source
 * without ever calling the resulting function, which is enough to surface that SyntaxError
 * without running any LLM-authored code.
 */
export function checkFrontendSyntax(files: Array<{ path: string; content: string }>): FrontendSyntaxCheckResult {
  // Last write wins - a retry rewrites frontend.html with corrected content, and only the
  // latest version is what will actually ship.
  const frontend = [...files].reverse().find((f) => f.path === 'frontend.html');
  if (!frontend) return { ok: true };

  for (const body of extractScriptBodies(frontend.content)) {
    try {
      // eslint-disable-next-line no-new-func -- intentional: parses without executing.
      new Function(body);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, output: `frontend.html <script> failed to parse as JavaScript: ${message}` };
    }
  }
  return { ok: true };
}
