# PostgreSQL and Neon adapters: transaction and driver research

Research for [Map #34](https://github.com/iianjun/fin/issues/34), [ticket #35](https://github.com/iianjun/fin/issues/35). Investigated 2026-11-08 against main `365d21e485586fded76c284e959fee27435d0431`. This is a first-pass decision input, not implementation or runtime validation. No credentials were read, services provisioned, database connections opened, or tests executed.

## Recommendation and alternatives

**Proposal:** begin direct PostgreSQL with `pg` and Neon with `@neondatabase/serverless` WebSocket `Pool`/`Client`, using pinned interactive transactions. Both can support fin's synchronous decision without translating domain rules into SQL. Neon remains a separate consumer adapter because its transport and connection lifetime differ. No server platform pairing is required.

HTTP is also feasible, but requires an optimistic snapshot/decision/guarded-commit protocol. Prefer it initially only if HTTP-only runtime portability outweighs more SQL planning, concurrency failure cases, and transport validation. Neither direction settles constructor shape, ownership, supported runtimes, or a same-database interoperability promise; those remain human decisions.

| Direction | Benefit | Cost / constraint |
| --- | --- | --- |
| Direct PostgreSQL + pinned `pg` client | Ordinary PostgreSQL transaction semantics; local integration testing | TCP/TLS and Node-oriented driver/runtime dependency |
| Neon WebSocket + pinned client | Interactive transactions; similar transaction policy to direct PG | WebSocket availability; request-bound lifetime in edge runtimes |
| Neon HTTP + guarded commit | Fetch-based deployment; no open transaction while deciding | Separate consistent read and commit; guard must abort the whole write; more projection planning |

## Existing contract and repository evidence

[FinStorage](https://github.com/iianjun/fin/blob/365d21e485586fded76c284e959fee27435d0431/packages/provider/src/storage.ts) requires a consistent read projection, one synchronous pure mutation decision, no writes for unchanged decisions, atomic data/revisions/exact supplied Change Record, protection of all read dependencies through changed commits, and no automatic decision/write replay. Uncertain outcomes must be `OUTCOME_UNKNOWN`.

[SQLite](https://github.com/iianjun/fin/blob/365d21e485586fded76c284e959fee27435d0431/packages/sqlite/src/adapter.ts) decides inside an immediate transaction. [D1](https://github.com/iianjun/fin/blob/365d21e485586fded76c284e959fee27435d0431/packages/d1/src/adapter.ts) validates a Vault generation/stamp around context reads and submits a constraint-enforced commit guard before planned writes. The internal stamp changes on every changed mutation, including changes that do not alter the public Vault revision. Public revision alone is therefore insufficient as a whole-context guard.

Relevant existing [D1 tests](https://github.com/iianjun/fin/blob/365d21e485586fded76c284e959fee27435d0431/packages/d1/src/adapter.test.ts) cover async decisions, data/revision/history rollback, competing same-snapshot commits, lost commit responses, mixed contexts, redirects and no replay. The existing financial suite is [core/fin.test.ts](https://github.com/iianjun/fin/blob/365d21e485586fded76c284e959fee27435d0431/packages/core/src/fin.test.ts). These are test requirements to port, not evidence that PostgreSQL or Neon already passes.

## Verified transaction and driver facts

PostgreSQL defaults to Read Committed: successive SELECTs can observe different commits within one transaction. Repeatable Read uses a stable transaction snapshot and prevents phantoms, but does not by itself prevent every serialization anomaly. Serializable can reject transactions; fin must return conflicts rather than automatically rerun them. [PostgreSQL isolation](https://www.postgresql.org/docs/current/transaction-iso.html).

A `FOR UPDATE` lock lasts until transaction end and blocks competing lockers/writers of that row. In Repeatable Read, attempting to lock a row changed since the snapshot can fail. Locking existing entity rows alone does not lock absent duplicate candidates or every category/transaction predicate. [PostgreSQL locking](https://www.postgresql.org/docs/current/explicit-locking.html).

`pg` requires the same client for BEGIN, all statements, COMMIT/ROLLBACK; `pool.query()` cannot provide that affinity. [node-postgres transactions](https://node-postgres.com/features/transactions). Acquired clients must be released; broken clients can be destroyed with `release(true)`; `pool.end()` drains the pool. Idle pool errors need handling. [Pool API](https://node-postgres.com/apis/pool).

Neon HTTP `transaction([...], { isolationLevel: 'RepeatableRead', readOnly: true })` runs a fixed query list in one non-interactive transaction. Its function overload constructs queries; it does not receive prior query results and is not an interactive decision callback. WebSocket Pool/Client provide sessions and interactive transactions. Node driver minimum is 19; Node 22+ includes WebSocket, while older environments need a constructor. Edge connections must be used and closed within one request. HTTP requests/responses have a 64 MB limit. [Neon driver documentation](https://neon.com/docs/serverless/serverless-driver).

The inspected Neon package manifest reports `1.2.0`, includes declarations, and declares Node `>=19`. Its own dev dependency includes Drizzle `^0.45.2`; this does not prove fin compatibility. [First-party package manifest](https://raw.githubusercontent.com/neondatabase/serverless/main/package.json). Pin selected versions and validate them rather than treating moving documentation as a compatibility gate.

Drizzle documents `node-postgres`, `postgres.js`, Neon HTTP and WebSocket integrations. The actual WebSocket import is `drizzle-orm/neon-serverless`. [PostgreSQL integrations](https://orm.drizzle.team/docs/get-started-postgresql), [Neon integrations](https://orm.drizzle.team/docs/connect-neon). fin currently pins Drizzle `0.45.4`. In that exact version, Neon HTTP `batch()` delegates to the driver's batch transaction, but `.transaction(callback)` throws; there is no interactive HTTP callback to reuse. [Pinned neon-http source](https://raw.githubusercontent.com/drizzle-team/drizzle-orm/0.45.4/drizzle-orm/src/neon-http/session.ts).

Pinned [node-postgres session](https://raw.githubusercontent.com/drizzle-team/drizzle-orm/0.45.4/drizzle-orm/src/node-postgres/session.ts) and [Neon session](https://raw.githubusercontent.com/drizzle-team/drizzle-orm/0.45.4/drizzle-orm/src/neon-serverless/session.ts) acquire a pooled client, run the transaction callback once, commit, roll back on errors, and release. They contain no transaction retry loop. Their catch path can replace the original error if rollback fails; adapter outcome classification must preserve commit-phase uncertainty rather than blindly trusting the final thrown error.

Neon's inspected HTTP execution path performs one fetch and has no retry loop. It exposes database error fields for HTTP 400, while other failures may be generic errors. This is source inspection, not a promise about proxies, custom fetch functions, or every driver path. [HTTP implementation](https://raw.githubusercontent.com/neondatabase/serverless/main/src/http/index.ts). Configuration supports fetch options, and `poolQueryViaFetch` is an experimental global option currently defaulting false. Avoid per-request global configuration changes. Use an acquired client for interactive work regardless of that option. [Neon configuration](https://raw.githubusercontent.com/neondatabase/serverless/main/CONFIG.md).

## Proposed atomic protocols

### Initial interactive path

1. Acquire one client. Read projections in an explicit Repeatable Read, read-only transaction.
2. For an existing-Vault mutation, begin Repeatable Read and lock its root row before loading dependent context. Every cooperating writer must acquire that root lock before changing any dependent row. A competing snapshot may fail before the decision; return a conflict without replay.
3. Load the bounded context, invoke `decide` once, reject thenables before financial writes, and reject nested storage calls during the callback.
4. If unchanged, finish without data/history/stamp updates. If changed, persist the supplied changes, revisions, record and incremented internal stamp in the same transaction; return the original result only after confirmed commit.
5. Vault creation has no existing root: use atomic inserts and unique keys. The current create-Vault context is empty, so it does not need a fictitious global catalog lock.

This deliberately serializes writes within one Vault, hiding predicate/absence protection behind one policy. Different Vaults remain independent. It costs throughput and lock waiting; a timeout/conflict is acceptable, automatic replay is not. Serializable with explicit conflict handling is an alternative if non-cooperating write paths must be considered, but must be evaluated as a whole access policy, not added as a replacement for defining supported writers.

### Optional HTTP path

Read context plus generation/stamp in one Repeatable Read HTTP batch, or one SQL projection. Existing context loading makes later queries depend on earlier rows, so compiling the required projection is real work; a fixed batch is not a mechanical conversion of awaited queries. Decide once outside the server transaction.

For a changed decision, submit one transaction that atomically compares generation/stamp, advances the root stamp and persists the entire supplied decision. A zero-row conditional UPDATE is not sufficient: subsequent unguarded writes would still run. Use a server function that raises on failed guard, or a constraint-backed assertion tied to the CAS result, so failure aborts the complete transaction. PostgreSQL Read Committed re-evaluates UPDATE predicates after a concurrent writer; this is the basis for the CAS proposal, not evidence that untested SQL already works. [UPDATE concurrency behavior](https://www.postgresql.org/docs/current/transaction-iso.html).

The guard must cover absence checks and aggregates, not only changed entities. Unchanged decisions return from the consistent read snapshot without a write. Do not move the pure core decision into a SQL function; a commit function receives and validates the guarded plan. No path regenerates revisions or Change Records after a conflict.

## Errors, replay and uncertain outcomes

**Proposed mapping:** preserve core `FinError`s; confirmed guard mismatch, `40001` serialization failure, `40P01` deadlock, and intentionally configured lock contention become `CONFLICT/not_applied`. Classify known duplicate constraints individually; do not label every integrity failure a user conflict. Other confirmed transactional failures become sanitized `STORAGE_FAILURE/not_applied`; incompatible schema becomes `SCHEMA_INCOMPATIBLE`.

SQLSTATE is preferable to localized message text. PostgreSQL explicitly defines `08007` as unknown transaction resolution. [Error codes](https://www.postgresql.org/docs/current/errcodes-appendix.html). Track whether COMMIT or an HTTP atomic-write request may have been submitted. Lost acknowledgement, timeout, malformed success, ambiguous service failure or disconnect after that point is `OUTCOME_UNKNOWN/unknown`. A later successful ROLLBACK does not prove a preceding COMMIT failed. Destroy an uncertain session; never return it as healthy or automatically resend. Recovery is inspection of current state and history, not blind repetition.

Audit the exact selected driver, transport hooks and proxy chain for replay. New connections after idle failure are distinct from replaying an active financial transaction. Pinning and fault tests remain required; documentation alone is insufficient.

## Schema, migrations and interoperability

The [SQLite schema](https://github.com/iianjun/fin/blob/365d21e485586fded76c284e959fee27435d0431/packages/sqlite/src/storage/schema.ts) is not portable unchanged: `sqliteTable`, PRAGMA inspection, `rowid`, `json_valid`, `typeof`, boolean encodings and SQL functions need PostgreSQL assets. Preserve domain constraints, composite Vault keys, exact history payloads and deterministic history ordering. Define a PG history ordinal rather than relying on physical row order.

Use `bigint` for minor units with fin's safe-integer bounds; PostgreSQL `integer` is only 32-bit. [Numeric types](https://www.postgresql.org/docs/current/datatype-numeric.html). Validate conversion and aggregate results before producing JavaScript numbers; `pg` supports custom parsers and can return unsupported types as strings. Avoid global parser changes. [Data types](https://node-postgres.com/features/types). JSON preserves input text; JSONB changes formatting/key order, so select according to the required payload semantics. [JSON types](https://www.postgresql.org/docs/current/datatype-json.html). Test date strings, nulls, ordering and name uniqueness/collation explicitly.

**Proposal:** one versioned PostgreSQL migration identity and preparation policy can serve direct PG and Neon, and potentially Supabase. Preparation must atomically serialize concurrent initializers, verify namespace/ledger, preserve unrelated tables, reject partial/unknown schemas, and avoid destructive repair. Neon recommends a direct endpoint for migrations; its pooled endpoint uses transaction pooling and does not preserve session settings or session advisory locks. Use qualified names and transaction-scoped policy. [Neon pooling](https://neon.com/docs/connect/connection-pooling).

**Human decision:** promise same-schema/same-Vault interoperability across PG, Neon and Supabase, or support independent databases only. A shared promise requires every direct/WS writer and Supabase guarded-commit RPC to obey one root-lock/CAS/stamp protocol, generation lifecycle, migration identity and Change Record encoding. The Supabase snapshot RPC must read a consistent snapshot including the same guard. Independent adapters that merely have similar table names are insufficient. Supabase grants/RLS and RPC installation add separate deployment costs; ordinary raw SQL writes outside the protocol cannot be treated as supported fin mutations.

Share proven PostgreSQL schema/encoding and atomic-commit policy only where callers no longer need to understand those invariants. Keep TCP/WS/HTTP lifetime and error evidence local. Do not invent a universal SQL transport abstraction or new wrapper modules solely to make adapter files look alike.

## Required validation and remaining decisions

Locally, run the financial contract on real PostgreSQL, not a SQLite substitute. Add two-client races for revisions, duplicate predicates, category ancestry, account settings and aggregate balances; ensure one decision per submitted mutation and full rollback on forced late history failure. Cover async/nested decisions, no-op history, migration contention/partial failure, detached methods, pool cleanup, safe integer boundaries and packed-package import/type isolation.

Use a controllable proxy/transport to drop a COMMIT acknowledgement after an actual database commit, distinguish failure before submission, count submissions and verify unknown outcomes without replay. Test HTTP stale guards that abort every write, including forced failures after earlier statements. Local WS/HTTP proxies can test chosen machinery, not hosted Neon behavior.

Hosted Neon still needs actual direct/pooled and chosen transport checks: concurrency, late-statement rollback, response loss, cold/restarted connection behavior, public errors and lifecycle in each promised runtime. No hosted claims are established here. Live decisions are initial Neon transport, minimum supported runtimes, adapter-owned versus injected clients/pools and shutdown API, migration defaults/admin path, interoperability guarantee, and whether HTTP merits a first-release implementation ticket.
