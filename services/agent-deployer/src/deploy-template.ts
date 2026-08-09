import type { Language } from '@swarmforge/agent-framework';

type DeployerLanguageProfile = {
  baseImage: string;
  buildCommands: string[];
  deployFiles: string[];
  runStart: string;
};

// Partial: only languages with a real Coder profile get an entry here. Any Language without one
// (including 'go'/'rust', which are valid Language values but out of scope for this cut) falls
// back to the typescript profile via resolveProfile below.
const DEPLOYER_LANGUAGE_PROFILES: Partial<Record<Language, (hostname: string) => DeployerLanguageProfile>> = {
  typescript: () => ({
    baseImage: 'ubuntu/nodejs@22',
    buildCommands: ['corepack enable', 'pnpm install', 'pnpm build'],
    // 'src/frontend.html' alongside 'dist': tsc only compiles .ts -> dist/, it never copies
    // frontend.html there, but index.ts's GET "/" route reads it from src/ at runtime.
    deployFiles: ['dist', 'src/frontend.html', 'package.json', 'node_modules'],
    runStart: 'node dist/index.js',
  }),
  python: () => ({
    baseImage: 'ubuntu/python@3.12',
    buildCommands: ['pip install -r requirements.txt'],
    deployFiles: ['src', 'requirements.txt'],
    runStart: 'python src/main.py',
  }),
};

function resolveProfile(hostname: string, language: Language): DeployerLanguageProfile {
  const factory = DEPLOYER_LANGUAGE_PROFILES[language] ?? DEPLOYER_LANGUAGE_PROFILES.typescript!;
  return factory(hostname);
}

export function renderZeropsYaml(hostname: string, language: Language): string {
  const profile = resolveProfile(hostname, language);
  const buildCommandLines = profile.buildCommands.map((c) => `        - ${c}`).join('\n');
  const deployFileLines = profile.deployFiles.map((f) => `        - ${f}`).join('\n');
  return `zerops:
  - setup: ${hostname}
    build:
      base: ${profile.baseImage}
      buildCommands:
${buildCommandLines}
      deployFiles:
${deployFileLines}
    run:
      base: ${profile.baseImage}
      start: ${profile.runStart}
      ports:
        - port: 3000
          httpSupport: true
`;
}

export function renderServiceImportYaml(hostname: string, language: Language): string {
  const profile = resolveProfile(hostname, language);
  return `services:
  - hostname: ${hostname}
    type: ${profile.baseImage}
    enableSubdomainAccess: true
`;
}
