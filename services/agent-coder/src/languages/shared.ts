export type CoderLanguageProfile = {
  scaffold(productDir: string, name: string): Promise<void>;
  instructions(hostname: string): string;
  compileCheck(productDir: string): Promise<{ ok: boolean; output: string }>;
  entrypointFilename: string;
};

export const FRONTEND_INSTRUCTIONS =
  'ALSO write exactly one more file, "frontend.html" (not under any subfolder): a single ' +
  'self-contained static HTML page - inline <style> and <script>, zero external ' +
  'dependencies, zero build step - implementing the ONE screen described in the proposal\'s ' +
  '"Frontend:" paragraph. It is never checked by tsc and never imports the backend file, so ' +
  'wire it up with realistic inline sample data (const literals) rather than a live fetch() ' +
  'to the backend - it must render meaningfully opened on its own. Design it minimal and ' +
  'clean: generous whitespace, a clear visual hierarchy, restrained color use, no lorem ' +
  'ipsum placeholder text.\n' +
  'The <script> in frontend.html runs directly in the browser with NO transpile step - it ' +
  'is plain JavaScript, NOT TypeScript. Never write TypeScript-only syntax there: no `as ' +
  'SomeType` casts, no `: type` annotations on variables/params/returns, no interfaces. A ' +
  'single such statement throws a SyntaxError that silently kills every event listener in ' +
  'the whole script block, not just that line - this has actually happened, so treat it as ' +
  'a hard rule, not a style preference.';
