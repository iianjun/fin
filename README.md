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
for creating, updating, listing, archiving, and reactivating Accounts and selecting or clearing
the default Income and Expense Accounts. Category tools create and maintain three-level
hierarchies with complete current paths. Every tool accepts a local Vault folder path. Mutation
responses report the material values that were actually applied. Transaction tools record, list,
and inspect Income and Expense with immediate Account balance results. Classification tools split
Transactions across explicit or inferred Category Assignments and report signed uncategorized
remainders. Adjustment tools apply signed balance deltas or calculate them from requested target
balances without recording Income or Expense. Transfer tools move same-currency or cross-currency
value between Accounts without creating false Income or Expense. Related-expense tools record
Refunds as negative Expenses, attach optional original-Expense links, record transfer fees as
positive Expenses linked to Transfers, and expose related Transactions before a multi-Transaction
change. Transaction lifecycle tools edit every Transaction shape in place, hard-delete active
Transactions, render immutable Change Records in natural language, and create a new Transaction
identity from deletion history. Query tools report currency-separated balances and net worth,
filter Transactions with evidence-backed Income and Expense totals, and aggregate Expense through
current Category rollups, memo matches, and explicit uncategorized amounts. The safe Agent
operation applies local-date and default-Account values transparently, returns ambiguity candidates
without mutation, requires confirmation for new Categories and likely duplicates, and identifies
every explicit, defaulted, inferred, or confirmed value in its receipt.

## Design

- [Product specification](docs/specs/local-first-personal-finance-ledger.md)
- [Implementation tickets](docs/issues/)
- [Product language](CONTEXT.md)
- [Product behavior](docs/product-behavior.md)
- [Database schema](docs/database-schema.md)
- [Architecture decisions](docs/adr/index.md)
