# Supabase adapter (provisional)

`@fin/supabase` implements the existing `FinStorage` contract using the official
`@supabase/supabase-js 2.119.0` SDK and its Data API `.rpc()` calls. Target: Node **24.x**.
**Hosted RPC verification passed** on 2026-11-08 with Node 24.18.0 and hosted PostgreSQL 17.11; see the scoped-installation boundary and evidence below.
No registry release, browser/user-JWT profile, other runtime or concurrent
same-Vault access through another adapter is promised.

## Administrator preparation

1. Choose a dedicated test project for verification. Production provisioning and
   migration of existing financial data are separate work.
2. An authorized database owner applies the complete bundled `sql/001.sql` through
   SQL Editor or the existing migration workflow. The installed private schema is
   `fin_supabase`; the three public RPC names start with `fin_supabase_`.
   The SQL ships in the package; `import.meta.resolve('@fin/supabase/sql/001.sql')`
   locates it. Application runtime credentials never execute SQL or create tables.
3. Installation is transactional and serialized by an advisory lock. It accepts
   only an empty namespace. Reapplying it, encountering an existing partial
   installation or an unknown version fails without repair. This is the initial
   schema, not an upgrade or data transformation runner; future upgrades need
   separate versioned administrator-applied assets.
4. The installation issues `NOTIFY pgrst, 'reload schema'`. Wait for schema-cache
   readiness, then run the check below. A cache miss is an explicit failure;
   financial operations are never automatically retried.

```js
import { createSupabaseAdapter } from '@fin/supabase'
import { createFin, createVault } from '@fin/core'

const storage = createSupabaseAdapter({
  url: process.env.SUPABASE_URL,
  apiKey: process.env.SUPABASE_SECRET_KEY, // server-held sb_secret_ key
})
await storage.checkSchema() // optional explicit startup check; no installation
const { vault } = await createVault({ storage, name: 'Household' })
const fin = createFin({ storage, vaultId: vault.id })
const { account } = await fin.createAccount({
  name: 'Cash',
  nature: 'asset',
  currency: 'KRW',
})
await fin.recordIncomeExpense({ kind: 'income', accountId: account.id, amountMinor: 1000 })
```

Construction validates settings synchronously and creates its own SDK client without I/O. SDK session persistence, automatic token refresh and URL session detection are disabled; database retries are explicitly disabled. First use checks the
schema within the context RPC; there is no stale readiness cache. `checkSchema()`
is check-only. There is no `migrate()` or empty `close()` method. HTTP(S) project
origins are accepted, with HTTP restricted to loopback. Optional `timeoutMs`
defaults to 30000 (1–120000); optional `fetch` is for host transport integration
and must not retry requests or follow redirects. The adapter forces manual
redirects but cannot see retries inside a supplied `fetch`: a wrapper that resends
a failed POST can apply a commit twice, defeating `OUTCOME_UNKNOWN`. Pass a plain
non-retrying `fetch` or omit it.

The SDK owns RPC request construction, serialization and service response parsing. A narrow custom-fetch policy enforces manual redirects and JSON responses, and removes this SDK version's modern-key Bearer fallback so only the `apikey` header carries the modern secret key; it is not put in a Bearer
JWT header. The hosted gateway maps secret access to `service_role`. All tables,
sequences and internal functions are in a private schema with no runtime-role
access. Three `SECURITY DEFINER` RPCs, with fixed `pg_catalog, pg_temp` search paths and
fully qualified objects, are granted only to `service_role`, not PUBLIC, anon or
authenticated. The host must authorize every caller and Vault before using this
credential. A secret key is not end-user identity or Vault authorization.

## Storage policy

A STABLE context RPC returns one snapshot containing raw Vault/settings/accounts,
categories, transactions and exact ordered history. Counts and envelope identity,
request nonce, Vault scope, dependencies and value shapes are checked before the
single synchronous core decision. TypeScript derives category paths and uses
BigInt intermediates for account balances, rejecting unsafe final aggregates.
Core alone decides product rules and constructs Change Records.

The initial implementation loads the complete selected Vault, including history,
then projects the requested result locally. It favors a simple coherent snapshot
and complete dependencies over large-ledger query efficiency. It has no streaming
or unbounded-ledger scalability claim; payload/time limits need service evidence.

The commit RPC locks the Vault root and validates its immutable generation plus
monotonic bigint stamp. Stamps travel as decimal strings, preserving values above
JavaScript's safe integer range. A different account's commit, predicate insert,
ABA change or replacement generation invalidates the whole stale plan. No zero-row
UPDATE is treated as successful validation. Creation uses an atomic unique insert.
All supplied state/revisions, assignment/relation edges, history and one stamp
advance commit in the same database transaction. No-op and failed decisions send
no commit RPC. Async and nested decisions are rejected, including swallowed nested
calls and later continuations of invalid async decisions.

Payloads use JSONB with generated storage keys and foreign-key/uniqueness
constraints. Derived account balances and category paths are not stored as
financial authority. Logical values round-trip exactly, including NUL, literal
backslashes and unpaired UTF-16 surrogate code units: the HTTP boundary escapes
backslash as `\\`, NUL as `\0` and unpaired surrogates as `\uXXXX` within JSON
string values, and validates/decodes those sequences on successful reads. JSON
keys and safe integer amounts remain ordinary JSON. Raw SQL inspection must take
this representation into account. SQL stores supplied record payloads without
reconstructing their snapshots.

Compatibility uses the exact bundled asset SHA-256 identity plus an installed
catalog fingerprint of columns/defaults, constraints, indexes, triggers, policies,
RLS settings, ownership, grants and RPC definitions. Schema drift fails before
financial writes; runtime never repairs data or DDL. This is an accidental drift
check, not protection against a malicious database administrator who can change
both code and its attestation ledger.

Confirmed structured PostgreSQL abort/rejection receipts map to public errors.
Redirects, timeouts/disconnects, ambiguous gateway errors and incomplete/mismatched
commit receipts after submission produce `OUTCOME_UNKNOWN`. Neither adapter nor
SQL replays a write or decision. Inspect state and Change Records through an
independent operation before deciding what to do next. Raw service errors and
credentials are not copied into public errors.

## Verification

```sh
pnpm check

# A dedicated local PostgreSQL cluster whose admin can create/drop test databases.
# Supply a PostgREST 16.5 executable separately; Linux CI pins its release digest.
export SUPABASE_TEST_DATABASE_URL='postgresql://postgres:local-test-password@127.0.0.1:5432/postgres'
export POSTGREST_BIN='/absolute/path/to/postgrest'
pnpm test:supabase:local
```

The reference is PostgreSQL **18.6** and PostgREST **16.5**. The local fixture creates
run-owned databases and test roles in the explicitly selected dedicated cluster;
it translates the test modern-key header into a locally signed legacy JWT. That
translation is test plumbing, **not hosted secret-key evidence**. Every fixture
removes its database and stops its PostgREST process. Consumers receive the official Supabase SDK transitively; they do not supply a constructed SDK client. `pg 8.23.1` is independent test inspection only. Runtime dependencies are provider-contract, `@supabase/supabase-js 2.119.0` and `zod 4.6.7`.

The explicit gate includes public financial/tools contracts, real races for
absence/name/duplicate/category/settings/aggregate dependencies, whole-Vault and
generation/ABA guards, exact supplied revisions/history, late-failure rollback,
coherent snapshots, installation/privilege/cache/drift checks and response loss
**after an actual successful commit**. Deterministic faults and independent
packed JS/TS/import checks also run in the normal three-OS Node 24 CI. Real
PostgreSQL/PostgREST has a separate Linux job. Configuring a job is not evidence
that its remote execution has passed.

```sh
# Dedicated hosted test project; secrets are supplied out of band.
export SUPABASE_TEST_DEDICATED=1
export SUPABASE_TEST_URL='https://test-project.supabase.co'
export SUPABASE_TEST_SECRET_KEY='sb_secret_...'
export SUPABASE_TEST_DATABASE_URL='postgresql://administrator:...@test-database/postgres'
pnpm test:supabase:hosted
```

For the administrator PostgreSQL connection, use `sslmode=verify-full` and
`sslrootcert=/absolute/path/to/prod-ca-2021.crt` in the connection URI. Download
the CA from the project's Database Settings → SSL configuration. This verifies
both the certificate chain and hostname; the public Data API retains its ordinary
HTTPS trust configuration. See [Supabase SSL enforcement](https://supabase.com/docs/guides/platform/ssl-enforcement).

The hosted command applies SQL only in per-fixture randomly named private schemas
and public RPC names, routes the adapter calls to those names, inspects commits
through independent admin SQL and drops only run-owned assets. Financial values
and RPC bodies are not rewritten for isolation. Local role-JWT calls are not
substituted for modern secret-key calls in hosted mode. Use an administrator
connection that supports the SQL preparation and teardown (not a restricted
application connection). A missing credential fails the command; it is never
counted as a skip/pass. Do not run this against a production project.

Because of that isolation, a hosted run exercises a renamed copy of `sql/001.sql`,
not the bundled `fin_supabase` schema and `fin_supabase_*` RPC names verbatim.
Hosted evidence must state this and does not by itself prove the unmodified asset
installs and serves through the hosted gateway; unscoped local fixtures apply it unchanged.

The [hosted verification record](https://github.com/iianjun/fin/issues/43#issuecomment-6721868639) reports 148 passing tests on implementation `69d47ff`: 31 real hosted conformance checks, 14 Supabase financial-contract scenarios, 4 Supabase tool scenarios, an actual hosted packed-package consumer, deterministic SDK checks and existing adapter regressions. It covers modern-key/gateway/RPC access, cache readiness and real commit acknowledgement loss with independent SQL inspection. An independent dashboard query confirmed zero remaining run-owned schemas, RPCs and host-data tables. The record names the tested versions, commands, installation renaming and cleanup scope; it does not establish other runtime versions or unchanged-name hosted deployment. Remote PR CI is a separate delivery check.
Relevant transport/SQL/concurrency/schema/dependency changes invalidate earlier
evidence for the affected behavior.

Primary references: [SDK initialization](https://supabase.com/docs/reference/javascript/initializing), [SDK RPC](https://supabase.com/docs/reference/javascript/rpc), [retry configuration](https://supabase.com/docs/guides/api/automatic-retries-in-supabase-js), [API keys](https://supabase.com/docs/guides/getting-started/api-keys),
[PostgREST transactions](https://docs.postgrest.org/en/stable/references/transactions.html),
[schema cache](https://docs.postgrest.org/en/stable/references/schema_cache.html).
