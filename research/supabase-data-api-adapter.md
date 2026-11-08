# Supabase HTTP Data API adapter: consistency and preparation

Research for [Research Supabase Data API consistency and schema preparation](https://github.com/iianjun/fin/issues/36), under [Add PostgreSQL, Neon, Supabase, and Turso storage adapters](https://github.com/iianjun/fin/issues/34). Researched 2026-11-08 against repository base `365d21e485586fded76c284e959fee27435d0431`. This is a design investigation, not implemented or service-verified behavior. No credentials, projects, or live databases were accessed.

## Recommendation and alternatives

Keep the promised project URL + API key interface and implement HTTP calls to installed database RPC functions. Supabase's Data API is PostgREST at `<project-url>/rest/v1/`; it supports database functions and can complement an existing application server. It does not require browser execution. [Supabase Data API](https://supabase.com/docs/guides/api)

Recommend an initial trusted-host adapter using a secret key, a coherent context RPC, and a guarded commit RPC. The TypeScript core remains the sole financial decision maker. Installation is a separate administrative SQL operation. This assumes the host already owns caller authorization and every writer obeys the storage protocol.

| Direction | Benefit | Cost / constraint |
| --- | --- | --- |
| Snapshot RPC + guarded commit RPC | Keeps URL/key runtime; short database transactions; core executes once locally | Requires installed SQL helpers; conservative Vault-wide conflicts |
| Individual REST reads/writes | Minimal initial helper setup | Independent requests cannot provide the required atomic multi-table commit; reject for this contract |
| Long-lived database transaction across client decision | Natural fit for a direct PostgreSQL connection | HTTP RPC requests do not share such a transaction; adds lease/session machinery if emulated |
| Publishable key + user JWT + database authorization | Can give each caller restricted database access | Requires explicit identity plumbing and ownership policies/checks; URL/key alone is insufficient for user identity |

The request transaction boundary is documented by PostgREST; the tradeoffs above are design conclusions. A connection-string adapter remains a separate PostgreSQL product, even when its server is Supabase. [PostgREST transactions](https://docs.postgrest.org/en/stable/references/transactions.html)

## Repository requirements and platform evidence

[FinStorage](https://github.com/iianjun/fin/blob/365d21e485586fded76c284e959fee27435d0431/packages/provider/src/storage.ts) requires one consistent context, one synchronous pure decision, no write for an unchanged result, and one atomic commit of state, affected revisions, and the supplied Change Record. It prohibits automatic decision/write retries and requires `OUTCOME_UNKNOWN` for uncertain application. [Core change construction](https://github.com/iianjun/fin/blob/365d21e485586fded76c284e959fee27435d0431/packages/core/src/change.ts) supplies identities, revisions, timestamps, and snapshots; SQL must not reconstruct them.

**Documented:** PostgREST defaults to READ COMMITTED. POST to a VOLATILE function permits writes; STABLE functions are read-only under PostgREST. Database errors and raised exceptions roll back the request transaction. These facts supply primitives, not a ready-made FinStorage guarantee. [Transactions](https://docs.postgrest.org/en/stable/references/transactions.html)

**Documented:** READ COMMITTED can see different committed data between commands. PostgreSQL SQL/PLpgSQL STABLE functions use the calling query's snapshot throughout their SELECTs; VOLATILE functions take fresh snapshots for their internal queries. A multi-query VOLATILE context helper is therefore insufficient by default. [Isolation](https://www.postgresql.org/docs/current/transaction-iso.html), [function volatility](https://www.postgresql.org/docs/current/xfunc-volatility.html)

## Proposed algorithm, requiring implementation proof

1. **Read once:** POST a request descriptor to a SELECT-only STABLE context function. Return one validated envelope containing the complete requested DomainContext, schema/protocol version, and the Vault's immutable generation plus monotonic commit counter, all from the same snapshot. Include derived balances, category ancestry, duplicate candidates, relations, and history dependencies required by the request. Do not truncate an internal projection or paginate it across independent snapshots. The existing [D1 context reader](https://github.com/iianjun/fin/blob/365d21e485586fded76c284e959fee27435d0431/packages/d1/src/storage/context.ts) identifies relevant projections; PostgreSQL SQL must implement equivalent semantics.
2. **Decide once locally:** validate the envelope, invoke the supplied synchronous callback exactly once, reject thenables and nested storage calls before sending any commit, and keep its result locally. Do not send or execute the callback in SQL. An unchanged decision returns its result without a commit RPC; a thrown domain error sends no writes. These paths linearize at the coherent read snapshot, not a promise that the Vault remains unchanged afterward. This is the proposed interpretation consistent with the existing [SQLite](https://github.com/iianjun/fin/blob/365d21e485586fded76c284e959fee27435d0431/packages/sqlite/src/adapter.ts) and [D1](https://github.com/iianjun/fin/blob/365d21e485586fded76c284e959fee27435d0431/packages/d1/src/adapter.ts) no-op paths, not a Supabase guarantee.
3. **Commit once:** POST the observed guard, request descriptor, decided DomainChanges, and exact Change Record to a VOLATILE commit function. At READ COMMITTED, first lock the Vault row FOR UPDATE, then compare its current generation/counter and compatible protocol version. A missing/mismatched guard raises a dedicated recognizable error before domain writes. PostgreSQL documents that the lock waits for a competing writer and then returns its updated row, and remains held until transaction end. [Row locks](https://www.postgresql.org/docs/current/explicit-locking.html)
4. **Apply atomically:** under that lock, validate storage shape/scope, persist supplied entity revisions, update transaction children and deletions, insert history with a unique record ID, and increment the counter. Any failure must escape the function and roll back everything; never catch a failure and return a success-shaped value. Return a small validated receipt identifying record and guard, then return the saved callback result. The [D1 write plan](https://github.com/iianjun/fin/blob/365d21e485586fded76c284e959fee27435d0431/packages/d1/src/storage/changes.ts) illustrates the required state/history grouping.

The counter covers **every mutation in the Vault**, including changes to predicates that previously matched no rows. Entity revision checks alone miss concurrent duplicate candidates, new category descendants, and transaction-derived balances. A unique generation prevents a deleted/recreated Vault from reusing an old counter. New Vault creation has an empty context and uses a unique Vault ID plus atomic initial rows/history; ID collision is confirmed rejection, never an overwrite. These are proposed protocol properties.

All writers must lock the same Vault first and advance the same counter. This includes direct PostgreSQL/Neon adapters sharing this database, importers, repair tools, and other SQL functions. A direct adapter that only locks its touched entity rows breaks the HTTP adapter's proof. Share a storage protocol/schema where justified, or explicitly prohibit mixed access to a Vault until interoperability tests pass. Permissions or mandatory helper access should constrain bypass; administrator SQL remains a trusted maintenance boundary. Vault-wide guards sacrifice unrelated-write concurrency for simpler predicate protection.

Store the supplied Change Record as an immutable payload, including exact before/after values, balances, settings, IDs, and timestamp; do not recalculate it from post-commit state. JSONB preserves JSON values but changes object-key order/whitespace; use JSON/text if byte identity becomes required. Encode internal bigint counters as decimal strings and validate financial numbers as safe integers at the JavaScript boundary. PostgreSQL documents JSONB representation changes and numeric interchange risks. JSONB also rejects escaped NUL characters; string representability, including names/memos stored in PostgreSQL text, needs an explicit round-trip design rather than silent stripping. [JSON types](https://www.postgresql.org/docs/current/datatype-json.html)

## Keys, grants, RLS, and host authorization

**Documented:** modern publishable/secret keys go in the `apikey` header; they are not JWTs. Publishable without a user session maps to `anon`, with a user JWT to `authenticated`; secret maps to `service_role`, which bypasses RLS. Table grants still matter. Legacy anon/service_role JWT keys coexist but should be handled explicitly, not confused with modern key headers. [API keys](https://supabase.com/docs/guides/getting-started/api-keys)

**Proposed initial profile:** an existing trusted host keeps the secret key and enforces current-caller Vault access before invoking core. Keep base tables in a non-exposed storage schema; expose only versioned, narrowly granted RPC entry points. Revoke PUBLIC/anon/authenticated execution, then grant only the intended runtime role. An invoker helper is simpler but requires that role's underlying schema/table privileges; it relies on a trusted writer discipline. A restricted-owner definer helper can offer function-only access with fewer caller table privileges, at the cost of a larger security review.

**Documented:** invoker is the default. Definer runs with its owner's privileges; a postgres-owned function may bypass RLS. Restrict EXECUTE, fix `search_path`, and fully qualify relations. EXECUTE grants alone do not enforce ownership of returned rows. [Database functions](https://supabase.com/docs/guides/database/functions)

RLS applies to underlying table operations, not function execution grants. A publishable-key mode would need both user identity and explicit Vault ownership checks/policies; filtering away some context rows could make core decide from incomplete data. Never treat a missing row caused by RLS as proof that a financial dependency does not exist. [Securing the API](https://supabase.com/docs/guides/api/securing-your-api)

The repository's [FinVaultAccess boundary](https://github.com/iianjun/fin/blob/365d21e485586fded76c284e959fee27435d0431/README.md#financial-tools) still authorizes listing, creation destinations, and direct-ID access per call. A privileged database key does not identify the end user or replace that boundary. No new host, browser-direct mode, or mandatory Node.js-plus-Worker pair follows from this proposal; implementation must verify the actual HTTP/JSON/crypto APIs needed in the selected JavaScript runtime.

## Installation and upgrades

An API key does not imply permission to create schemas/functions or perform arbitrary SQL. PostgREST can execute DDL **through a function already installed with sufficient privileges**; that does not bootstrap the first helper. Do not expose an arbitrary-SQL administrator RPC to manufacture auto-migration parity. [RPC capabilities](https://docs.postgrest.org/en/stable/references/api/functions.html)

The simplest honest setup is:

1. Distribute versioned SQL; the project administrator applies it through an authorized SQL/database migration workflow. Install tables, constraints, history ordering, generations/counters, helpers, a migration identity ledger, grants, and chosen security policy together.
2. Configure exposed RPC schema and intended privileges. A custom schema requires explicit exposure in Supabase API settings; grant only required privileges rather than copying broad example grants. [Custom schemas](https://supabase.com/docs/guides/api/using-custom-schemas)
3. Construct runtime storage with project URL and API key. First use checks helper/schema identity; missing or incompatible preparation returns `SCHEMA_INCOMPATIBLE` with administrative setup guidance, without modifying existing data.
4. Apply upgrades administratively, coordinate concurrent migrators, preserve records, and define the supported client/helper version overlap. Supabase supports versioned SQL migrations and deployment to linked projects. [Migrations](https://supabase.com/docs/guides/local-development/database-migrations), [deployment](https://supabase.com/docs/guides/deployment/database-migrations)

Function signature changes need deliberate versioning: CREATE OR REPLACE cannot change argument or return types, and retains existing ownership/permissions. [CREATE FUNCTION](https://www.postgresql.org/docs/current/sql-createfunction.html) Refresh PostgREST's schema cache after helper changes; PostgreSQL NOTIFY is supported, but readiness must be checked rather than assumed immediately. [Schema cache](https://docs.postgrest.org/en/stable/references/schema_cache.html)

## Failures, retries, and verification boundary

**Documented SDK behavior:** current supabase-js retries idempotent GET/HEAD/OPTIONS on selected transient failures; POST RPC is not retried by that built-in policy. It supports disabling retries. Prefer a minimal injected fetch transport or explicitly disabled SDK retries, and require host transport wrappers not to replay writes. SDK policy is not an end-to-end exactly-once delivery guarantee. [Retry documentation](https://supabase.com/docs/guides/api/automatic-retries-in-supabase-js)

**Proposed mapping:** a validated guard error, serialization failure, or deadlock rollback becomes `CONFLICT`; confirmed schema/permission/input rejection is non-application. Match structured codes, not HTTP status alone: PostgREST maps uniqueness violations to 409 and transaction rollbacks to 500. [Error codes](https://docs.postgrest.org/en/stable/references/errors.html) After submission, timeout, disconnect, gateway failure, invalid JSON, or a missing/mismatched receipt yields `OUTCOME_UNKNOWN` unless rollback is positively established. Abort does not prove rollback. Never rerun core or resubmit the write automatically. Read history/target state for recovery; absence of a record while an old request may still be executing does not prove non-application. This policy follows [FinStorage](https://github.com/iianjun/fin/blob/365d21e485586fded76c284e959fee27435d0431/packages/provider/src/storage.ts), not a documented Supabase recovery facility.

No tests were run. Proposed proof work:

- Local PostgreSQL/PostgREST or local Supabase: coherent multi-table reads; two commits from one guard; predicate inserts; account balances; exact history; no-op/throw/async decisions; injected mid-write rollback; create collision; generation replacement; migrations and mixed direct/HTTP writers.
- HTTP fault injection: commit succeeds but response is lost; malformed success; abort; redirects; one callback invocation and one submitted write.
- Separately authorized hosted checks: actual gateway/key-role behavior, grants/RLS, cache propagation, payload/timeout limits, and runtime transport. Local execution does not verify those service layers; Supabase distinguishes local and hosted CLI targets. [Local and hosted projects](https://supabase.com/docs/guides/local-development/local-and-hosted-projects)

## Decisions for the Map

Recommend administrator-installed helpers, trusted-host secret-key mode, and conservative Vault-wide guards first. User decisions still needed: whether publishable-key/user-JWT support belongs in the initial scope; whether mixed direct/HTTP access to the same Vault is required immediately; and whether manual SQL setup is acceptable or an existing deployment migration workflow must be integrated. These choices affect authorization/setup scope, not the requirement to keep Supabase runtime traffic on the HTTP Data API.
