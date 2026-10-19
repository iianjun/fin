# fin

A personal-finance library with pluggable storage adapters and reusable MCP tools.

The initial storage targets are local SQLite and Cloudflare D1. Consumers choose
where to run the library and whether to expose it through an MCP server.

This repository currently contains only the monorepo foundation.

## Workspace

```text
apps/       Runnable applications and integration examples
packages/   Reusable libraries and adapters
```

## Requirements

- Node.js 24 or newer
- pnpm 12.14.0

## Getting started

```sh
pnpm install
```

Installation configures Git hooks through lefthook. The pre-commit hook checks
staged changes for whitespace errors.

Run the hook manually with:

```sh
pnpm hooks:check
```
