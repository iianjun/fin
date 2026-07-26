# fin

A local-first personal finance system managed through natural language.

## Requirements

- Node.js 24 LTS
- pnpm 11.15.1

## Workspace

```text
apps/
└── mcp/       MCP stdio adapter

packages/
└── core/      Reusable product behavior
```

## Commands

```sh
pnpm install
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

The repository currently contains the monorepo foundation only. MCP tools and product behavior
will be implemented separately.
