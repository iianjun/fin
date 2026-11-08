# Turso adapter

Provisional `@fin/turso`, targeting Node **24.x** and the **new Turso Database engine**. The package exposes `createTursoAdapter` and its options type. HTTP, ordered streams, schema assets and SQL execution are internal. There is no public transport package/subpath, Turso SDK or libSQL fallback.

**hosted verification pending**. The adapter is implemented, but actual engine SQL, isolation, constraints, routing, expiry and durability remain unverified without a dedicated new-engine endpoint. Local SQLite-backed protocol tests are supplemental adapter/SQL evidence and do not establish Turso support. Track acceptance in [Implement the Turso storage adapter](https://github.com/iianjun/fin/issues/44).

```ts
import { createTursoAdapter } from '@fin/turso'
import { createFin, createVault } from '@fin/core'

const url = process.env.TURSO_URL
const authToken = process.env.TURSO_AUTH_TOKEN
if (!url || !authToken) throw new Error('Missing Turso settings')
const storage = createTursoAdapter({ url, authToken })
try {
  // Optional startup preparation; default first use prepares an empty namespace.
  await storage.migrate()
  const { vault } = await createVault({ storage, name: 'Household' })
  const fin = createFin({ storage, vaultId: vault.id })
  const { account } = await fin.createAccount({ name: 'Cash', nature: 'asset', currency: 'KRW' })
  await fin.recordIncomeExpense({ kind: 'income', accountId: account.id, amountMinor: 1000 })
  console.log(await fin.queryBalances())
} finally {
  await storage.close()
}
```

Construction is synchronous, validates options and performs no I/O. `url` is an HTTPS origin with no credentials/path/query; `authToken` is a nonempty bearer token. `autoMigrate` defaults to true. Set it false to check compatibility on ordinary use; explicit `migrate()` still prepares an empty namespace. Preparation never creates a logical Vault. Unknown, partial or altered fin assets fail with `SCHEMA_INCOMPATIBLE`; no destructive repair runs. Every operation checks the adapter-specific SHA-256 migration identity and exact stored table/index/view SQL, including unexpected triggers on fin tables. Similar SQLite/D1 assets are not an interoperability or adapter-switching guarantee. Unrelated host objects are preserved.

Optional `allowedRouteOrigins` explicitly authorizes service-documented HTTPS origins for protocol next-request routing. By default, credentials stay on the configured origin. This is separate from HTTP redirects, which are rejected with manual redirect handling. `timeoutMs` bounds each request and body (1–60000 ms, default 10000). Optional `fetch` supports instrumentation/fault testing; it must honor single submission, cancellation and manual redirects and must never retry internally.

Each admitted read, mutation or migration owns a fresh stream. It verifies foreign-key session constraints before separately acknowledged BEGIN IMMEDIATE, then keeps schema checking, all context reads, one synchronous decision and supplied state/revisions/history on that stream through a strictly acknowledged COMMIT. Unchanged decisions and decision failures produce no financial writes/history. Async decisions and nested same-adapter calls (including later async continuations and swallowed failures) are rejected. Methods remain usable when detached.

This initial implementation loads complete Vault dependencies, computes account balances using bigint, validates safe integer boundaries, and only then projects the requested entities/filters. A three-level category view matches core's current depth limit. This favors correctness and auditability over large-Vault read volume and lock duration. Reads use IMMEDIATE too, with the same conservative concurrency cost. Actual new-engine IMMEDIATE locking/conflict scope must be measured; no Vault-scoped locking claim is made. There is no automatic statement, decision or write replay, nor an unverified engine-code mapping to `CONFLICT`.

All protocol envelopes, statement metadata, columns, rows and values are checked before use. Zod **4.6.7** validates financial rows, supplied plans and complete history snapshots without casting or stripping fields. Integers remain int64 bigint until an explicit safe-number projection. Exact supplied Change Records and revisions are persisted together; account balances and category paths are derived. Public storage/protocol errors omit SQL, server messages, tokens and batons; core FinErrors retain their domain semantics.

A complete matching COMMIT execute result plus autocommit result is required for success. Once COMMIT may have been submitted, missing/malformed/error/lost acknowledgements yield `OUTCOME_UNKNOWN`, even if cleanup succeeds or fails. Inspect persisted state and Change Records independently before deciding whether to submit a new operation. A missing acknowledgement is never evidence of rollback.

`close()` stops admission immediately, drains already admitted preparation/reads/decisions/writes/release and returns the same promise repeatedly. It does not forcibly cancel callbacks. Stream release is bounded best effort; a lost/consumed baton can leave a transaction/resource until server-defined expiry. No expiry duration is inferred. Cleanup never deletes financial data or changes the reported financial outcome.

## Verification

```sh
pnpm check
pnpm test:turso:hosted
```

Default checks build/type the package, run the existing public createFin financial contract and tools, real SQLite-backed v3 adapter integration, deterministic protocol/adapter faults, independent actual tarball JS/TS financial consumers, and existing SQLite/D1/stdio/Worker regressions. The existing three-OS Node 24 CI discovers these checks. One local run is not a remote three-OS CI result. There is no new Turso Worker or other-runtime support claim. Runtime dependencies are existing `@fin/provider` and pinned Zod; unrelated drivers remain unnecessary.

The explicit hosted command exits **2** with `hosted verification pending` when required access is absent; it never skips or provisions services. Supply environment variables through the local environment, never committed files:

- `TURSO_TEST_URL`, `TURSO_TEST_AUTH_TOKEN`: dedicated disposable new-engine database credentials.
- `TURSO_TEST_DEDICATED_NEW_ENGINE=1`: operator assertion; a SQL version string cannot identify the engine.
- `TURSO_TEST_ENGINE_METADATA`: available deployment/build evidence, or an honest description of unavailable details, with no secrets.
- Optional `TURSO_TEST_ROUTE_ORIGINS`: comma-separated exact service-authorized HTTPS origins.

The command first runs `test/feasibility.mjs` against run-owned `fin_probe_<uuid>_` objects, then runs the common financial and tools contracts plus `test/conformance.test.ts` through actual `createTursoAdapter` on the real endpoint. Test-only fetch instrumentation renames SQL identifiers/schema metadata to independent `fin_test_<uuid>_` namespaces; financial bound values/history are unchanged. Each fixture checks absence before ownership, cleans only its own namespace and independently verifies absence afterward. Failed cleanup reports the retained prefix and fails the gate.

Checks include exact production preparation/identity, financial values/history, independent-client missing/name/duplicate/category/settings/aggregate dependencies, stale edits, real late history constraint rollback, and an actual successful COMMIT acknowledgement deliberately lost inside fetch with one decision/commit and independent state/history inspection. Candidate feasibility also covers protocol values, FK/CHECK/UNIQUE constraints, cascade behavior and held-IMMEDIATE observations. Its 250 ms window is a bounded feasibility observation, not proof of every engine schedule.

Record command output, date, source/implementation identity, exact Node/dependency versions, available engine metadata and pass/fail/pending gates on the issue. Changes to SQL, protocol, migration, concurrency or dependencies invalidate affected evidence. Single-origin observations leave node routing unexercised; idle expiry/failure characterization remains pending until measured on the selected service. Passing executable checks alone does not close unexercised mandatory evidence gates.

Protocol baseline: [SQL-over-HTTP v3 at d064d97544f940e7198e4635f8c9212bf80385a0](https://github.com/tursodatabase/turso/blob/d064d97544f940e7198e4635f8c9212bf80385a0/serverless/PROTOCOL.md). Required metadata/strict policies must match the actual hosted release; never relax them or fall back to libSQL silently.
