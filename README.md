# fin

A personal-finance library with pluggable storage adapters.

Consumers choose where to run the library and whether to expose it through an MCP
server.

The workspace includes `@fin-kit/provider` for shared financial data types, the
storage contract, and errors, `@fin-kit/core` for Vault-scoped financial operations,
`@fin-kit/sqlite` for local SQLite storage, `@fin-kit/d1` for options-based Cloudflare
D1 REST access, `@fin-kit/postgres` for direct PostgreSQL storage, `@fin-kit/neon` for Neon WebSocket storage, and `@fin-kit/tools` for selectable agent tools with an optional
`@fin-kit/tools/mcp` registration entrypoint. Packages are private, names are
provisional, and nothing has been published to a registry.

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
remote Cloudflare REST service. The checks also exercise shared tools, exact MCP
financial errors, a real stdio process, an actual Worker HTTP host with local D1,
and packed-package installation in independent JavaScript/TypeScript consumers.
The installation gate reuses the pnpm store populated by `pnpm install` and can
fetch registry metadata when its isolated cache is empty. It covers temporary
paths containing spaces and `~`. To format files, run `pnpm format`. To build and
run only the tests, run `pnpm test`. CI runs each check on macOS, Ubuntu, and Windows.

Direct-library and MCP examples live in the single `apps/example` workspace package.

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
import { createFin } from '@fin-kit/core'
import { createD1Adapter } from '@fin-kit/d1'

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
validation. The original implementation passed its mandatory remote financial,
rollback, concurrency and public-error gates; see the
[D1 completion record](https://github.com/iianjun/fin/issues/28#issuecomment-6717405283)
for exact evidence and limitations. Those historical checks are separate from
the reproducible local suite. HTTP redirects are never followed or replayed;
the adapter uses the Worker-compatible `redirect: 'manual'` option. This transport
adjustment has local Worker and redirected-write regression coverage; an additional
remote MCP check has not yet run. Current verification status is recorded in the
[MCP integration task](https://github.com/iianjun/fin/issues/29).

## Neon

[`@fin-kit/neon`](packages/neon/README.md) provides settings-owned Neon WebSocket
sessions on Node 24.x, with `createNeonAdapter({ connectionString, autoMigrate? })`,
explicit `migrate()` and draining `close()`. It uses the pinned official Neon driver
without requiring the standalone `pg` runtime. Local integration runs with
`pnpm test:neon:local`; actual direct/pooled verification is a separate required
`pnpm test:neon:hosted` gate. See the package guide for credentials, isolation,
transaction guarantees and the current support-evidence status.

## PostgreSQL

`@fin-kit/postgres` targets Node 24.x and direct PostgreSQL 18.6, with `pg` 8.23.1.
The adapter owns its connection pool; consumers supply a connection URL:

```ts
import { createFin, createVault } from '@fin-kit/core'
import { createPostgresAdapter } from '@fin-kit/postgres'

const connectionString = process.env.DATABASE_URL
if (!connectionString) throw new Error('DATABASE_URL is required')
const storage = createPostgresAdapter({ connectionString })
try {
  const { vault } = await createVault({ storage, name: 'Household' })
  const fin = createFin({ storage, vaultId: vault.id })
  await fin.createAccount({ name: 'Cash', nature: 'asset', currency: 'KRW' })
} finally {
  await storage.close()
}
```

Validate configuration before constructing the adapter. The factory performs no
network I/O. Preparation is lazy and automatic by default; `autoMigrate: false`
checks compatibility without creating tables, and `await storage.migrate()`
explicitly prepares an empty namespace. Storage owns the `public.fin_*` tables,
indexes, view and migration ledger in the selected database. It preserves unrelated
host objects, serializes initial preparation with a transaction advisory lock,
and rejects missing, partial, unknown or structurally changed schemas without
repair. The current version supports initial creation only, not data migration.
Ordinary runtime users need access to fin tables and the history sequence;
initial preparation additionally needs CREATE on the public schema.

Reads use one repeatable-read transaction. Mutations lock the existing Vault root
before loading dependencies, invoke the synchronous decision once, and commit
state, supplied revisions and the exact supplied Change Record together. Writers
to the same Vault serialize, including name, absence, category, settings and balance
dependencies; different Vaults can progress independently. Vault creation uses a
unique primary key. There is no automatic retry of transactions or decisions.
These guarantees require all writers to use this adapter's locking policy; direct
SQL edits and concurrent use through other adapters are outside the contract.

The initial context implementation loads a Vault's account/transaction dependencies
before applying projections, so memory and read cost grow with its ledger size.
Balances aggregate in PostgreSQL numeric arithmetic and are range checked before
conversion to JavaScript numbers. Amount columns reject unsafe integers, while
assignment/relation order and exact history snapshots survive round trips.
Text uses a reversible encoding for NUL, lone UTF-16 surrogates and backslashes
in names, identifiers, memos and history. Reads restore the original strings before
Core decisions and searches; literal escape sequences remain distinct from the
characters they resemble. The migration identity includes this encoding policy,
so a schema prepared with a different text format is rejected without rewriting data.

A lost or malformed COMMIT acknowledgement returns `OUTCOME_UNKNOWN`, even if
rollback or cleanup also fails. Inspect state and Change Records before deciding
whether to submit again. `close()` rejects new work, drains admitted operations,
then closes the pool; repeated calls share the same completion promise. Closing
from inside a decision is rejected. Broken sessions are discarded, and cleanup
cannot replace a confirmed financial result.

Run the actual-engine gates against a dedicated test server whose account can
create databases (a non-superuser with CREATEDB is sufficient):

```sh
# Set FIN_POSTGRES_URL through your local secret/environment configuration.
pnpm verify:postgres
```

This command fails if the variable is missing. Each fixture creates a unique
`fin_test_*` database and drops only its own database, including after failure.
It covers the shared financial contract, separate-client races, snapshots,
preparation/late-write rollback, a wire-level lost successful COMMIT reply,
lifecycle, existing tools and independent JS/TS tarball consumers. The wire fault
proxy is for local plaintext test connections; it forces `sslmode=disable` and
must not be used to intercept a production or TLS-required endpoint.
`pnpm check` retains all existing SQLite/D1/stdio/Worker regressions and always
runs deterministic PostgreSQL lifecycle/fault and package/type/import checks.
Without `FIN_POSTGRES_URL`, actual PostgreSQL tests are skipped, not counted as
verification. CI adds a Linux PostgreSQL 18.6 service pinned by image digest.
No other PostgreSQL major, Node major, Worker runtime or service-specific adapter
is claimed by these tests. Detailed execution evidence belongs to
[Implement the PostgreSQL storage adapter](https://github.com/iianjun/fin/issues/41).

## Agent tools

Use `@fin-kit/core` directly for ordinary application code. `@fin-kit/tools` adds agent-facing
descriptions, strict schemas, read/write annotations and execution. It imports no
MCP server, SQLite driver or host framework. Select only the tools your agent needs:

```ts
import { createFinTools, type FinVaultAccess } from '@fin-kit/tools'

// Supply the current caller's authorized catalog, creation destination and scoped core.
declare const access: FinVaultAccess
const tools = createFinTools({
  access,
  tools: ['vaults.list', 'vaults.resolve', 'vaults.create', 'balances.query'],
})

const vaults = await tools['vaults.list'].execute({})
const matches = await tools['vaults.resolve'].execute({ name: 'Household' })
// Ask for disambiguation when matches contains multiple IDs.
const { vault } = await tools['vaults.create'].execute({ name: 'New ledger' })
const balances = await tools['balances.query'].execute({ vaultId: vault.id })
```

Omit `tools` to select the entire catalog. Selectors group Vault lifecycle,
settings, accounts, categories, transactions, balances, spending and Change Records.
Each descriptor exposes `id` (the MCP name), `description`, `inputSchema`,
`annotations` and a typed `execute`. All arguments are strict objects; unknown
fields, missing Vault IDs, invalid calendar dates and unsafe integer amounts fail
before Core execution. Revision and domain rules remain in Core. Mutation results
retain `changed`, actual state, revisions and history semantics.

The host implements `FinVaultAccess`:

- `listVaults({ includeArchived? })`: return only permitted Vaults, with names,
  IDs, revisions and archive state. Listing requires no known ID.
- `createVault({ name })`: authorize a creation destination, call Core creation,
  and make the returned empty Vault available to subsequent list/get calls.
- `getFin(vaultId)`: authorize direct-ID access and return an immutable scoped
  Core instance. Reject unauthorized IDs with `FinError('FORBIDDEN', ...)`.

List/name lookup cannot substitute for direct-ID authorization. Every scoped tool
requires `vaultId`; no tool changes a global current Vault. `vaults.rename`,
`vaults.archive` and `vaults.reactivate` require the latest Vault revision.
Archived Vaults remain readable. No permanent Vault deletion tool is provided.

For a shared catalog, pass request access as `tool.execute(input, requestAccess)`;
it takes precedence over construction access. Tools never cache authorization or
replay failed writes. Read/write annotations describe tools; hosts enforce policy.

## MCP registration and hosts

Install the optional MCP server SDK alongside tools when using this entrypoint.
The integration is pinned to MCP server/client `2.4.0` and Zod `4.6.7`.
TypeScript Node hosts also use `@types/node`; no SQLite driver declarations are
required. Include `"types": ["node"]` in a Node host's TypeScript configuration.
Core and D1/tools consumers compile independently without Node typings:

```ts
import { McpServer } from '@modelcontextprotocol/server'
import { createFinTools, type FinVaultAccess } from '@fin-kit/tools'
import { registerFinTools } from '@fin-kit/tools/mcp'

declare const access: FinVaultAccess
const server = new McpServer({ name: 'fin', version: '0.0.0' })
registerFinTools(server, createFinTools({ access }))
// The host connects a transport and owns authentication and shutdown.
```

Registration, imports and tool assembly perform no catalog lookup or financial
I/O. For server reuse, `registerFinTools(server, tools, { getAccess(context) })`
resolves host-authenticated access for each tool invocation. HTTP hosts must use
the authenticated request's scope; tool arguments never authenticate a user.

Successful MCP responses contain `{ data: <original Core result> }` in both
`structuredContent` and JSON text. Financial failures have `isError: true` and
`{ error: { code, message, application, target?, recovery } }` in both fields.
Unexpected exceptions are sanitized to `OUTCOME_UNKNOWN`/`unknown` with state/history
inspection guidance. SDK schema/protocol failures use the SDK's own error surface.
No error path automatically retries financial writes.

`apps/example/mcp-stdio.mjs` authorizes the local process for its configured SQLite
database. It starts with an empty catalog, opens the database itself and closes
after transport shutdown. Configure `FIN_SQLITE_FILENAME` for persistence; the
default is `:memory:`. After `pnpm build`, an MCP client can launch it with:

```json
{
  "mcpServers": {
    "fin": {
      "command": "node",
      "args": ["/absolute/path/to/fin/apps/example/mcp-stdio.mjs"],
      "env": { "FIN_SQLITE_FILENAME": "/absolute/path/to/fin.sqlite" }
    }
  }
}
```

`apps/example/mcp-worker.mjs` exports a Worker HTTP handler at `/mcp`. Build it with
`pnpm build:example:worker`. The example reads a secret `FIN_DEMO_GRANTS` binding
containing an array of host-controlled grants. Each grant has `token`, `accountId`,
`databaseId`, `apiToken`, `allowCreate`, and optional `timeZone`. The Bearer token
authenticates the caller to its configured database; all Vaults in that database
are permitted. `allowCreate` controls only Vault creation. Separate databases are
used for separate example principals. Replace this demo policy with your own
authentication and persistent grants when embedding the tools in an application.
Core and tools require no particular OAuth provider or framework.

The host uses the options-based D1 REST adapter and a Worker-compatible SDK schema
validator. An optional `D1_REST` service binding can route its HTTP transport to
another service; the local test uses this to emulate the REST envelope around real
local D1. Neither schema preparation nor database discovery occurs during assembly.
The Worker creates request-local access/server state and closes its SDK handler
after the response; no current-user or current-Vault global is shared.

Run the actual child-process and HTTP host paths without external credentials:

```sh
pnpm build
pnpm exec vitest run packages/tools/src/hosts.test.ts
```

Focused tool, error and independent package gates are reproducible with:

```sh
pnpm exec vitest run packages/tools/src/tools.test.ts
pnpm exec vitest run packages/tools/src/mcp.test.ts
pnpm exec vitest run packages/tools/src/consumer.test.ts
```

The Worker HTTP gate uses esbuild `0.28.2` and Miniflare `4.20260730.0`, including
interleaved authenticated callers and unauthorized direct-ID access. The consumer
gate packs actual packages, installs Core-only, D1/tools and SQLite/MCP layouts,
executes them and compiles public TypeScript usage. No registry publish or
production deployment is part of these checks.

### Turso (provisional adapter)

The provisional [Turso adapter](packages/turso/README.md) supplies `createTursoAdapter({ url, authToken, autoMigrate? })` for the new Turso Database engine on Node 24.x through the official `@tursodatabase/serverless@1.4.1` SDK. It implements FinStorage, lazy schema preparation, financial changes/history and draining close. There is no fin-owned HTTP transport or SDK patch. SDK-based hosted verification remains pending; previous custom-protocol evidence does not apply. Known SDK limitations remain upstream responsibilities. See [Implement the Turso storage adapter](https://github.com/iianjun/fin/issues/44) for current constraints and evidence.

## Supabase adapter (provisional)

`@fin-kit/supabase` uses the official Supabase SDK with a project URL and server-held
modern secret key for Data API RPCs. An administrator first applies the bundled SQL; runtime only checks
compatibility and never installs schema. Core decisions remain local and supplied
state/history commits use a whole-Vault generation/stamp guard. Node 24.x is the
initial target. The [hosted RPC verification](https://github.com/iianjun/fin/issues/43#issuecomment-6721868639) passed on Node 24.18.0 / hosted PostgreSQL 17.11 with isolated SQL/RPC names. See [setup, API and verification](packages/supabase/README.md).
