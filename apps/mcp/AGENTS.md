# AGENTS.md

## Responsibility

- This package owns the stdio MCP adapter: protocol schemas, tool registration, and response
  mapping. Reusable product, validation, and persistence behavior belongs in `packages/core`.
- Keep the adapter transport-facing and thin. Read
  [ADR 0001](../../docs/adr/0001-separate-mcp-from-core.md) before moving behavior across the
  package boundary.

## Working contract

- `src/schema.ts` owns MCP input and output schemas.
- `src/server.ts` maps public core operations to tools, structured content, and human-readable
  content.
- `src/server.test.ts` verifies the protocol contract through an in-memory MCP transport.
- A tool contract change must keep those three surfaces aligned. MCP tests cover mapping; financial
  and persistence rules stay in core tests.

## Verification

Run the focused MCP tests during development:

```sh
pnpm exec vitest run --project @fin/mcp
```

Run every command in the root `AGENTS.md` before handoff.
