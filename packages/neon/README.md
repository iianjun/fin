# Neon storage

`@fin/neon` targets Node 24.x with the pinned `@neondatabase/serverless` 1.2.0
WebSocket driver and Node's native WebSocket. It owns its pool and sessions; no
standalone `pg` runtime, HTTP transaction fallback, or injected client is required.
Hosted support evidence is separate from local proxy evidence. See the verification
section for the exact commands and current limitations.

```ts
import { createFin, createVault } from '@fin/core'
import { createNeonAdapter } from '@fin/neon'

const connectionString = process.env.DATABASE_URL
if (!connectionString) throw new Error('DATABASE_URL is required')
const storage = createNeonAdapter({ connectionString })
try {
  await storage.migrate() // optional startup check/preparation
  const { vault } = await createVault({ storage, name: 'Household' })
  const fin = createFin({ storage, vaultId: vault.id })
  await fin.createAccount({ name: 'Cash', nature: 'asset', currency: 'KRW' })
} finally {
  await storage.close()
}
```

The factory validates options synchronously and performs no network I/O. Both
Neon direct and transaction-pooled PostgreSQL connection URLs use WebSockets.
`autoMigrate` defaults to true: first use prepares an empty `public.fin_*`
namespace. False checks only; `migrate()` explicitly allows initial creation.
Preparation serializes with a transaction-scoped advisory lock and checks the
migration identity and catalog structure. Unknown, partial, missing (check-only)
and incompatible structures fail without destructive repair. Unrelated host data
is preserved. Only initial schema creation is implemented, not data upgrades.
Runtime needs table/sequence access; bootstrap also needs CREATE on public.

Each operation checks out one session. Reads use repeatable-read snapshots;
mutations lock the Vault root before reading any dependencies. This serializes
same-Vault writers and protects absent rows, duplicate/name predicates, category
relationships, settings and aggregate balances. Different Vaults remain independent.
Vault creation uses atomic uniqueness. One synchronous decision produces atomic
state, supplied revisions and the exact supplied Change Record; unchanged results
and failed decisions add no financial writes/history. Nested and async decisions
are rejected. No transaction, decision or financial write is automatically replayed.

All search-path changes and preparation locks are transaction-local. Password
connection pipelining is disabled so authentication/readiness completes before
queries. Per-client settings select native secure WebSockets without changing the
process-wide Neon configuration. `pool.query()` and the HTTP query API are never
used. The connection deadline is 10 seconds and each query has a 30-second client
deadline. A timed-out or disconnected session is discarded; an interrupted COMMIT
has an unknown outcome even if rollback or cleanup later succeeds. These deadlines
bound waits, not the duration of a whole multi-statement operation.

A missing/malformed COMMIT acknowledgement returns `OUTCOME_UNKNOWN` with
`application: 'unknown'`. Inspect financial state and Change Records before
submitting another mutation. Confirmed database rejection remains `CONFLICT` or
`STORAGE_FAILURE` as appropriate. Errors omit connection URLs, credentials and SQL.
`close()` immediately stops admission, drains admitted work, then releases the pool and waits for actual session end events (pool bookkeeping
may finish before a native WebSocket closes).
It is asynchronous and idempotent. Cleanup cannot change a confirmed result or
resolve an uncertain one. A later operation may create a fresh connection after an
idle failure; it never replays an interrupted operation.

The initial projection loads Vault dependencies before applying filters, so its
cost grows with ledger size. SQL numeric aggregates are range-checked before
conversion to JavaScript numbers. Safe-integer columns, assignment/relation order,
exact JSON history, NUL/lone-surrogate/backslash encoding match the financial seam.
The proven PostgreSQL schema/storage policy is copied locally to avoid a shared
transport framework or an unused `pg` dependency. There is no cross-adapter
same-Vault, schema-switching or direct-SQL-writer interoperability guarantee.

## Verification

Default `pnpm check` runs build/types, independent JS/TS tarball installs, deterministic
fault tests and existing SQLite/D1/tools/stdio/Worker regressions. The existing
macOS/Linux/Windows Node 24 CI includes these gates. The added Linux job uses the
pinned PostgreSQL 18.6 image with a local WebSocket-to-TCP test bridge:

```sh
# FIN_NEON_URL: dedicated local PostgreSQL server, role with CREATEDB.
pnpm test:neon:local
```

Hosted verification is explicit and never silently skipped:

```sh
# Supply FIN_NEON_DIRECT_URL and FIN_NEON_POOLED_URL through a secret environment.
# Alternatively FIN_NEON_CREDENTIALS_FILE names a protected JSON file with
# string keys "direct" and "pooled". Never commit that file.
pnpm test:neon:hosted
```

Both URLs must address the same dedicated Neon project/database. The direct
connection administers unique `fin_neon_<run-id>_<uuid>` databases; the selected
endpoint runs the complete financial/storage/concurrency/preparation/lifecycle and
packed-consumer gates inside them. No financial or schema writes go to the source
database. Cleanup drops only databases owned by that invocation, including leftovers
from failed tests. The role needs CREATEDB. No project, branch or paid service is
provisioned; ordinary connections may wake an inactive compute.

The fault proxy forwards PostgreSQL frames through the actual hosted WebSocket
endpoint (or through TCP only for local tests), preserving one upstream session per
socket. It observes a real successful COMMIT, then drops or corrupts its acknowledgement, or withholds all further server frames
until the actual 30-second driver query timeout fires.
Independent connections verify persisted state/history; tests count one decision and
one financial COMMIT. Other gates observe native close events, recover on fresh
sessions, force pre-commit disconnects, late history failures, schema rollback and
root-lock waiters. A wrong default search path tests independence from retained
session settings. Connection/session restart evidence is not compute-restart evidence.

Tested runtime and dependency pins: Node 24.18.0, Neon 1.2.0, test-only ws 8.22.2.
Verified on 2026-11-12 UTC (2026-11-13 KST) at implementation commit
[`8e6c07d`](https://github.com/iianjun/fin/commit/8e6c07dba763552afb3a5f7a1ae9102a14e9b78a):
local PostgreSQL 18.6/WebSocket, actual Neon direct and actual Neon pooled commands
each passed all 96 tests. Totals include shared baseline and deterministic checks;
each command also executed the actual Neon financial/fault/lifecycle gates and
independent packed consumers. Hosted PostgreSQL reported 17.11 (9045acd), aarch64.
Both endpoint runs included failed-auth socket draining and actual successful COMMIT
acknowledgement loss, corruption and 30-second driver timeout. Source and built-file
SHA-256 manifests matched across both runs and the final tree. Independent inspection
found zero remaining run-owned databases, including earlier exploratory runs.

The same runtime commit passed the six CI jobs (macOS/Linux/Windows defaults,
PostgreSQL Linux, Supabase/PostgREST Linux and Neon WebSocket Linux); local `pnpm check`
passed 211 tests with 81 environment-gated skips, which are not integration passes.
These results establish the tested Neon/Node profile, not a fresh hosted claim for
other adapters or a compute-restart test. The implementation issue records commands,
evidence freshness and subsequent changes:
[Neon implementation #42](https://github.com/iianjun/fin/issues/42).

The driver audit checked the installed pinned distribution: checked-out Client
queries stay on its stream; the optional fetch path exists only on Pool.query;
query submission has no financial retry loop; native WebSocket emits frame/close
signals into the bundled PostgreSQL parser; pool release discards broken clients.
The package bundles its PostgreSQL protocol implementation and has no standalone
`pg` runtime dependency. See the [official driver documentation](https://neon.com/docs/serverless/serverless-driver)
and [configuration reference](https://github.com/neondatabase/serverless/blob/main/CONFIG.md)
for the selected session/configuration APIs; dependency or transport changes require
rerunning the corresponding local and hosted gates. Other Node majors, browsers,
Workers, Bun and Deno are not claimed.
