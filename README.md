# fin

A personal-finance library with pluggable storage adapters.

Consumers choose where to run the library and whether to expose it through an MCP
server.

The workspace includes `@fin/provider` for shared financial data types, the
storage contract, and errors, `@fin/core` for Vault-scoped financial operations,
`@fin/sqlite` for local SQLite storage, and `@fin/d1` for options-based Cloudflare
D1 REST access. MCP integration is planned. Packages are private and have not
been published to a registry. Remote D1 validation is still required before
the D1 adapter is considered complete.

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
storage contract tests, plus the same financial contract against actual local D1.
The local fixture emulates the REST envelope around D1; it does not verify the
remote Cloudflare REST service. To format files, run `pnpm format`. To build and run only
the tests, run `pnpm test`. CI runs each check on macOS, Ubuntu, and Windows.

Both SQLite and D1 examples live in the single `apps/example` workspace package,
with `sqlite.mjs` and `d1.mjs` as separate entry points.

## SQLite example

Run the in-memory example with:

```sh
pnpm example
```

It creates a Vault and account, records income and an expense, updates the expense
memo, and prints a KRW balance and net worth of 7000. The example closes its
connection when finished.

## D1 REST example

Consumers supply connection settings; the adapter constructs its own REST access
and Drizzle queries. It does not accept a database or ORM client:

```ts
import { createFin } from '@fin/core'
import { createD1Adapter } from '@fin/d1'

const storage = createD1Adapter({ accountId, databaseId, apiToken })
const fin = createFin({ storage, vaultId })
const accounts = await fin.listAccounts()
```

The factory performs no network I/O. Ordinary schema preparation happens on first
use unless `autoMigrate: false` is supplied; `await storage.migrate()` explicitly
prepares the database without creating a logical Vault. D1 has no owned local
connection to close. Optional `fetch` customization controls HTTP transport; a
custom transport must not automatically resend writes.

Set `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_D1_DATABASE_ID`, and
`CLOUDFLARE_API_TOKEN` for an existing test database, then run:

```sh
pnpm example:d1
```

The example lists Vaults with automatic migrations disabled. To prepare an empty
test database explicitly, run `pnpm example:d1 --migrate` first. The adapter does
not create Cloudflare resources.

Changed state, revisions, the Vault guard, and Change Records are submitted in
one commit batch. Context reads validate the same generation/stamp before and
after the bounded projection. A conflicting snapshot fails rather than rerunning
the core decision. Network failures or invalid responses after write submission
produce `OUTCOME_UNKNOWN`; inspect state and history before making another call.

The current context loader uses multiple primary REST requests with stamp
validation, rather than one read batch. Local tests verify SQL rollback and
concurrent commits; remote REST atomicity, primary behavior, and public error
translation remain unverified. See [the D1 implementation task](https://github.com/iianjun/fin/issues/28).
