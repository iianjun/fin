# fin

A personal-finance library with pluggable storage adapters.

The planned initial storage targets are local SQLite and Cloudflare D1, with
optional MCP integrations. Consumers choose where to run the library and whether
to expose it through an MCP server.

The workspace includes `@fin/provider` for shared financial data types, the
storage contract, and errors, `@fin/core` for Vault-scoped financial operations,
and `@fin/sqlite` for local SQLite storage. Cloudflare D1 and MCP integrations
are planned. Packages are private and have not been published to a registry.

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

## Development checks

Run the repository checks with:

```sh
pnpm check
```

This checks formatting with Oxfmt, lints with Oxlint, builds the workspace
packages, checks types with TypeScript, and runs the SQLite-backed financial and
storage contract tests. To format files, run `pnpm format`. To build and run only
the tests, run `pnpm test`. CI runs each check on macOS, Ubuntu, and Windows.
