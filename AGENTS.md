# AGENTS.md

## Project map

- See [CONTEXT.md](CONTEXT.md) when adding or changing product terminology.
- See the [ADR index](docs/adr/index.md) before changing architectural boundaries or workspace package structure.
- See the [conventions index](docs/conventions/index.md) before creating a branch or commit.

## Boundaries

- Dependencies may point from `apps/mcp` to `packages/core`, never in the opposite direction.
- `packages/core` must not depend on the MCP protocol, SDK, or transport layer.

## Verification

Run all checks before handoff:

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```
