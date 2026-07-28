# AGENTS.md

## Responsibility

- This package owns reusable product behavior, validation, SQLite persistence, and complete applied
  result contracts. Natural-language interpretation and MCP protocol mapping are caller and adapter
  responsibilities.
- `src/index.ts` is the public package surface. Keep internal helpers private unless another
  workspace package needs a stable core contract.

## Working contract

- `migrations/` is the executable schema, `src/vault.ts` discovers and applies migrations, and
  `src/persistence.ts` owns the shared atomic-mutation helper.
- Keep a mutation and its Change Record atomic. The
  [database schema](../../docs/database-schema.md) owns the detailed persistence invariants, and
  schema-level and operation tests catch drift.
- Core behavior tests use real SQLite through the public operation seam rather than mocking
  persistence.

## Verification

Run the focused core tests during development:

```sh
pnpm exec vitest run --project @fin/core
```

Run every command in the root `AGENTS.md` before handoff.
