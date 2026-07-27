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

## MCP server

Build the workspace, then configure an MCP client to launch the stdio server:

```sh
pnpm build
node apps/mcp/dist/index.js
```

The server exposes Vault lifecycle tools for initializing and opening a Vault, plus Account tools
for creating and listing Accounts and selecting or clearing the default Income and Expense
Accounts. Every tool accepts a local Vault folder path. Mutation responses report the material
values that were actually applied.

## Design

- [Product specification](docs/specs/local-first-personal-finance-ledger.md)
- [Implementation tickets](docs/issues/)
- [Product language](CONTEXT.md)
- [Product behavior](docs/product-behavior.md)
- [Database schema](docs/database-schema.md)
- [Architecture decisions](docs/adr/index.md)
