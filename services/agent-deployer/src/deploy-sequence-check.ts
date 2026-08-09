export type DeploySequenceCheckResult =
  | { ok: true }
  | { ok: false; expected: string[]; actual: string[] };

/**
 * Deployer's zerops.yaml/import YAML content is a static template
 * (`deploy-template.ts`) - the LLM only decides which tools to call and in what order, never
 * any file content. The risk here is a wrong or incomplete tool-call sequence, not hallucinated
 * file content, so this validates the sequence of recorded `zcli` invocations rather than any
 * YAML.
 */
export function validateDeploySequence(commands: string[], hostname: string): DeploySequenceCheckResult {
  const expected = [
    'zcli project service-import zerops-service-import.yaml',
    `zcli push ${hostname}`,
  ];
  const ok = commands.length === expected.length && commands.every((c, i) => c === expected[i]);
  return ok ? { ok: true } : { ok: false, expected, actual: [...commands] };
}
