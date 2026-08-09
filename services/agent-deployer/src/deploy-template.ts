export function renderZeropsYaml(hostname: string): string {
  return `zerops:
  - setup: ${hostname}
    build:
      base: nodejs@22
      buildCommands:
        - corepack enable
        - pnpm install
        - pnpm build
      deployFiles:
        - dist
        - package.json
        - node_modules
    run:
      base: nodejs@22
      start: node dist/index.js
      ports:
        - port: 3000
          httpSupport: true
`;
}

export function renderServiceImportYaml(hostname: string): string {
  return `services:
  - hostname: ${hostname}
    type: nodejs@22
    enableSubdomainAccess: true
`;
}
