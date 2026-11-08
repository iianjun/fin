# Selected Turso Database: released remote SDK and storage protocol

Research for [#40](https://github.com/iianjun/fin/issues/40), under [#34](https://github.com/iianjun/fin/issues/34). Checked 2026-11-08. This extends the [immutable initial investigation](https://github.com/iianjun/fin/blob/fcbfcff1d8c29a9a125dd95a9ccd1dda5ae57632/research/turso-adapter.md). The selected engine is the **new Rust Turso Database**, not libSQL. A separate adapter package, options-based ownership of its connection, ordinary automatic initial preparation with opt-out where possible, and optional Drizzle are user directions. The user also accepted synchronous factories without network I/O, lazy first-use readiness with an explicit preparation path, and close that stops new operations, awaits admitted operations and releases owned resources. This report does not settle the internal transport decision.

## Finding and recommendation

**The released remote SDK is `@tursodatabase/serverless@1.4.1`, but its unmodified implementation is not an acceptable FinStorage boundary.** The downloaded npm artifact includes dedicated interactive transactions and conditional atomic batches. It also accepts incomplete commit acknowledgements and incomplete cursor results, uses global fetch without a per-client transport hook, and omits a redirect policy. Fabricated-response probes reproduced these defects without contacting any database. A valid server response normally contains the omitted fields; these findings concern malformed/truncated response handling, not evidence that Turso normally emits invalid responses. [Published artifact](https://registry.npmjs.org/@tursodatabase/serverless/-/serverless-1.4.1.tgz), [release sequence/batch implementation](https://github.com/tursodatabase/turso/blob/d064d97544f940e7198e4635f8c9212bf80385a0/serverless/javascript/src/session.ts), [release transport](https://github.com/tursodatabase/turso/blob/d064d97544f940e7198e4635f8c9212bf80385a0/serverless/javascript/src/protocol.ts).

The recommended first protocol to validate is **one exclusively owned stream per operation, explicit session setup, then BEGIN IMMEDIATE, all context reads, one synchronous decision, state/revision/exact ChangeRecord writes, and one acknowledged COMMIT**. Prefer the pipeline endpoint with strict response validation to avoid depending on the released cursor parser. This is a proposal, conditional on hosted proof that IMMEDIATE protects the relevant reads and predicates against competing writers. It buys a small correctness model at the cost of holding the transaction across network round trips. [FinStorage contract](https://github.com/iianjun/fin/blob/365d21e485586fded76c284e959fee27435d0431/packages/provider/src/storage.ts), [protocol streams and transactions](https://github.com/tursodatabase/turso/blob/d064d97544f940e7198e4635f8c9212bf80385a0/serverless/PROTOCOL.md#4-streams).

Two real implementation directions remain:

| Direction | Benefit | Cost / unresolved gate |
| --- | --- | --- |
| Fixed upstream SDK release, or explicitly maintained pinned SDK patch | Retains SDK ownership and its value/session machinery | Must add per-instance transport control, strict complete acknowledgement/result validation, and test phase/error behavior; 1.4.1 alone does not supply this |
| Adapter-owned, narrowly scoped SQL-over-HTTP v3 transport | Owns one-submission semantics, manual redirects, validation, setup and commit phases directly | Adds responsibility for protocol compatibility, integer encoding, session lifecycle and error parsing; this is a user design decision, not a silent replacement for the chosen SDK boundary |

Do not globally monkey-patch fetch in a library. Do not silently substitute libSQL, Sync, local files, or a mandatory ORM. The wire protocol is concrete enough to implement the second direction, but no such implementation or hosted certification was performed here. [Protocol v3](https://github.com/tursodatabase/turso/blob/d064d97544f940e7198e4635f8c9212bf80385a0/serverless/PROTOCOL.md).

## Evidence ledger: release, source, docs and execution

| Item | Pin / observation | Evidence status |
| --- | --- | --- |
| fin remote main | `365d21e485586fded76c284e959fee27435d0431` | Read via GitHub MCP; research branch based on this remote commit, independent of the shared working branch |
| npm SDK | `@tursodatabase/serverless@1.4.1`; registry latest observed 2026-11-08; published 2026-10-06T08:03:23.505Z | Actual tarball downloaded and dist JS / declarations / manifest inspected |
| npm source provenance | registry `gitHead=d064d97544f940e7198e4635f8c9212bf80385a0` | Source pin associated with release; tarball contents are authoritative for shipped JS |
| newer source comparison | `9b71df9abfd5bef3ee3c157f7ffef57fa2ce49ba` | First report's current-main snapshot, not evidence for npm release or hosted engine version |
| probes | Node `v24.18.0`; imported extracted ESM tarball directly | Executed with fabricated global-fetch responses only; no SQL engine, credentials or database was used |
| official website | SDK reference, concurrency and Cloud limitations read on check date | Documentation claims; not conformance evidence for a particular hosted deployment |

The registry lists no runtime dependencies, optional dependencies, or peers for this release; there is no transitive runtime SDK tree to pin. The manifest exports ESM and CJS plus separate `/compat` entrypoints; its build tools and Node type declarations are development dependencies, and it declares no engines minimum. [Registry version metadata](https://registry.npmjs.org/@tursodatabase%2fserverless/1.4.1), [release manifest](https://github.com/tursodatabase/turso/blob/d064d97544f940e7198e4635f8c9212bf80385a0/serverless/javascript/package.json).

Downloaded artifact verification matched registry SHA-1 and SHA-512:

- Tarball: `https://registry.npmjs.org/@tursodatabase/serverless/-/serverless-1.4.1.tgz`
- SHA-1: `31d2b0a2579a3adb7360e68da48fc513ea493cf4`
- SHA-512 integrity: `sha512-kcbGx0zb0Js4WnIrIF4AlsK3gzryRdTyUQev/9UbxtcH/iyk7u0Rk+l7dWdPC/5Ymu1WlbSyn4oUb02eNbn6Mw==`
- Additional local SHA-256: `70aa24c6ad975845fe31e4af579638bb57f7b1df64b6cb6b8778555dee5165cf`

The engine running behind a remote URL is deployed independently of the JS npm release. Its exact build, feature flags, journal mode, primary routing and transaction expiry were **not established**. A release-source compatibility warning is a reason to test or avoid a feature, not proof of the hosted engine's exact behavior.

## Actual consumer construction, SQL preparation and lifecycle

This is the released SDK API, **not a proposed fin constructor**:

```ts
import { connect } from '@tursodatabase/serverless'

const connection = connect({
  url: 'https://example.invalid',
  authToken: 'supplied by the host',
  // Optional SDK fields:
  // remoteEncryptionKey, defaultQueryTimeout, requestHeaders
})
connection.defaultSafeIntegers(true)

const statement = await connection.prepare('SELECT id FROM fin_vaults WHERE id = ?')
const row = await statement.get(['vault-id'])
await connection.close()
```

`connect(config)` is synchronous and makes no network request. The required option is `url`; `authToken` is optional for local development. URL normalization maps `turso://` and `libsql://` to HTTPS; a URL spelling does not prove the engine behind it. `prepare(sql)` is asynchronous and issues `describe`; it does not prepare a schema. `run/get/all` on a Connection or Transaction skip that describe round trip. Statements support `safeIntegers()`, `raw()`, `pluck()`, `run/get/all/iterate`; no statement-finalize API is exported. `exec(sql)` sends a multi-statement sequence, and **does not create a transaction automatically**. [Release connection API](https://github.com/tursodatabase/turso/blob/d064d97544f940e7198e4635f8c9212bf80385a0/serverless/javascript/src/connection.ts), [statement implementation](https://github.com/tursodatabase/turso/blob/d064d97544f940e7198e4635f8c9212bf80385a0/serverless/javascript/src/statement.ts), [protocol sequence](https://github.com/tursodatabase/turso/blob/d064d97544f940e7198e4635f8c9212bf80385a0/serverless/PROTOCOL.md#63-sequence).

`await connection.close()` sets the main connection closed and attempts to close its stream. Session close suppresses network errors and does not apply the configured query timeout to the close request. It is best-effort cleanup, not proof that a previous commit did or did not apply. It does not drain in-flight dedicated `transactionAsync` sessions: they own their own cleanup. A fin-owned lifecycle must stop accepting operations and await active operations before closing. `reconnect()` exists but must not be used to replay a failed financial operation. [Release close implementation](https://github.com/tursodatabase/turso/blob/d064d97544f940e7198e4635f8c9212bf80385a0/serverless/javascript/src/connection.ts), [session close](https://github.com/tursodatabase/turso/blob/d064d97544f940e7198e4635f8c9212bf80385a0/serverless/javascript/src/session.ts).

There is no main-entrypoint schema/migration identity manager. The compat entrypoint has `migrate(statements)`, but it simply calls a write-mode batch and explicitly does not implement the intended foreign-key disabling behavior. That is neither a fin schema verifier nor an upgrade planner. Main `connect` plus main async `close` is the clearer lifecycle for this investigation; compat is not required. [Release compat source](https://github.com/tursodatabase/turso/blob/d064d97544f940e7198e4635f8c9212bf80385a0/serverless/javascript/src/compat.ts#L364).

## Sessions, atomicity and protocol alternatives

### Dedicated interactive transaction

The **released** API includes `connection.transactionAsync(async tx => { ... }).immediate()`, along with default/deferred/concurrent/exclusive variants. Each invocation allocates a fresh Session, begins before invoking the callback, gives it a dedicated Transaction handle, commits once, attempts rollback on error without replacing the original error, invalidates the handle, and closes its session. All transactional queries and prepared statements must use `tx`, not the outer connection. Ordinary connection calls use another stream. Connection and transaction calls are serialized on their respective locks. The old `transaction(fn)` is deprecated because unrelated connection calls can enter its transaction window. [Release transaction implementation](https://github.com/tursodatabase/turso/blob/d064d97544f940e7198e4635f8c9212bf80385a0/serverless/javascript/src/connection.ts#L460).

The callback's return being awaited is **not** permission to pass FinStorage's decision straight to it. The adapter must first load/validate the entire context, call the pure decision synchronously exactly once, reject a Promise/thenable before writes, and retain the supplied result and ChangeRecord snapshots. An unchanged decision sends no data/history/revision writes; ending its read transaction is still necessary. All read dependencies include absent rows and name/category/duplicate predicates, not just rows eventually changed. [FinStorage contract](https://github.com/iianjun/fin/blob/365d21e485586fded76c284e959fee27435d0431/packages/provider/src/storage.ts), [context and history](https://github.com/iianjun/fin/blob/365d21e485586fded76c284e959fee27435d0431/packages/sqlite/src/storage/context.ts).

Session PRAGMAs from the outer connection do not propagate. The wrapper begins before its callback, and exposes no setup-before-BEGIN hook or explicit commit phase callback. The exported lower-level `Session` can be owned manually to do setup, BEGIN, reads, writes and COMMIT with visible phases, but retains the same transport/validation defects. Contrary to a blanket SQLite assumption, release engine source sets `foreign_keys` directly and bumps prepared-statement context without an autocommit check. Thus callback-time foreign-key setup is **not proven impossible** for this engine; its hosted effect must be tested. Setup and verification before BEGIN on the exact stream remains the conservative protocol. [PRAGMA translation](https://github.com/tursodatabase/turso/blob/d064d97544f940e7198e4635f8c9212bf80385a0/core/translate/pragma.rs#L728), [engine setter](https://github.com/tursodatabase/turso/blob/d064d97544f940e7198e4635f8c9212bf80385a0/core/connection.rs#L1969).

The protocol provides strict stream ordering, one request in flight, rotating batons and node-pinning `base_url`. Idle expiry is server-defined; an expired stream loses its open transaction. Do not import libSQL's documented five-second timeout as the new engine's timeout. Documentation describes single-writer defaults and optional MVCC/concurrent writes; Cloud controls journal mode and busy behavior itself. Neither source alone proves hosted IMMEDIATE locking, serializable predicate protection, concurrent-mode conflict codes, or read-after-write routing. Those are conformance gates. [Protocol §§4–5](https://github.com/tursodatabase/turso/blob/d064d97544f940e7198e4635f8c9212bf80385a0/serverless/PROTOCOL.md#4-streams), [concurrent writes](https://docs.turso.tech/tursodb/concurrent-writes), [Cloud limitations](https://docs.turso.tech/cloud/limitations).

### Coherent snapshot plus guarded atomic commit

This is feasible at the protocol level and shortens the writer's lock window. It costs an additional concurrency protocol and explicit storage assets. Load all context and its generation/stamp **inside one read transaction on one stream**; do not combine unrelated connection reads into a snapshot. Close that snapshot, decide once in JavaScript, then issue a single atomic IMMEDIATE batch whose first data step fails a CHECK constraint unless the authoritative vault generation/stamp still matches. Follow it with supplied state/revisions/history and one stamp increment. A conditional UPDATE affecting zero rows is insufficient unless subsequent writes are gated on its actual match; protocol conditions test step success, not affected-row count. [Conditional batches](https://github.com/tursodatabase/turso/blob/d064d97544f940e7198e4635f8c9212bf80385a0/serverless/PROTOCOL.md#62-batch), [existing fin guarded commit](https://github.com/iianjun/fin/blob/365d21e485586fded76c284e959fee27435d0431/packages/d1/src/adapter.ts#L402).

Every writer must update the same monotonic stamp atomically. Generation prevents replacement/ABA; stamp decoding and increments must never lose precision or wrap. Dependencies outside the vault require an appropriate broader guard. An older replica snapshot is safe only if the commit guard is evaluated against the authoritative writer state and all dependencies are covered; no evidence here establishes that hosted routing contract. Do not transplant D1's multiple-primary-read algorithm or assume a replica's latest observed stamp proves a snapshot. On a known guard failure return CONFLICT; do not rerun the decision or batch.

For read-only `read(request)`, one explicit read transaction can provide a coherent multi-query projection if hosted snapshot semantics hold. Snapshot consistency and freshness are separate properties. The protocol has no documented per-request primary/freshness option in the inspected SDK config. Unknown replica behavior remains a gate.

### Batch and late failures

Main `connection.batch(statements)` without a mode is **not atomic**. Passing `'immediate'` creates BEGIN, condition-chained user steps, COMMIT only after the final user success, and ROLLBACK when BEGIN succeeded but COMMIT did not. A late constraint failure therefore triggers rollback in the server-side chain, assuming protocol conformance. A batch inside an already active transaction joins it and ignores the supplied mode; an exported Session itself is lower-level and has no public call serialization. [Release batch implementation](https://github.com/tursodatabase/turso/blob/d064d97544f940e7198e4635f8c9212bf80385a0/serverless/javascript/src/session.ts), [connection batch](https://github.com/tursodatabase/turso/blob/d064d97544f940e7198e4635f8c9212bf80385a0/serverless/javascript/src/connection.ts).

`DatabaseError` can include code, rawCode, cause, batchIndex, batchResults and rollbackError, but not every path populates them. Successful earlier batch result entries do not prove those effects were committed: atomic rollback can undo them. Conversely, missing error fields do not prove COMMIT succeeded. Late-failure rollback remains a hosted test, not something proved by fabricated responses.

## Transport audit and outcome evidence

The released transport performs one global fetch per pipeline/cursor request; source has no SQL replay/retry loop. It does not accept an injected fetch, redirect policy, or AbortSignal in Config. Query timeouts use `AbortSignal.timeout(ms)`; default has no timeout. Compat explicitly rejects custom fetch and integer-mode options. Pipeline HTTP failures lose response detail into a generic DatabaseError; JSON/body failures are not consistently wrapped. SDK type alone is insufficient for application classification. [Release protocol](https://github.com/tursodatabase/turso/blob/d064d97544f940e7198e4635f8c9212bf80385a0/serverless/javascript/src/protocol.ts), [session timeout](https://github.com/tursodatabase/turso/blob/d064d97544f940e7198e4635f8c9212bf80385a0/serverless/javascript/src/session.ts), [compat validation](https://github.com/tursodatabase/turso/blob/d064d97544f940e7198e4635f8c9212bf80385a0/serverless/javascript/src/compat.ts).

Fetch defaults to following redirects; 307/308 can resend the POST body. That violates the required no-replay boundary even without an SDK retry loop. Check `response.redirected` afterward is too late. A controlled implementation must set `redirect: 'manual'`, treat every redirect as failure, and never issue a second submission for that operation. The protocol's **next-request** `base_url` routing is distinct: validate an allowed HTTPS destination before sending the next statement and its credentials; never resubmit the previous one. [Fetch request redirect mode](https://fetch.spec.whatwg.org/#concept-request-redirect-mode), [HTTP redirect algorithm](https://fetch.spec.whatwg.org/#http-redirect-fetch), [protocol base URL](https://github.com/tursodatabase/turso/blob/d064d97544f940e7198e4635f8c9212bf80385a0/serverless/PROTOCOL.md#46-the-base-url).

The following defects were reproduced in shipped JS:

| Fabricated response | Observed 1.4.1 behavior | Fin consequence |
| --- | --- | --- |
| HTTP 200 JSON `{ baton: null, base_url: null }` to BEGIN and COMMIT | `transactionAsync(...).immediate()` resolves normally | Cannot infer BEGIN or commit acknowledgement from wrapper success |
| Atomic-batch arrays of the right length, valid user result, null BEGIN and COMMIT results and no errors | Batch resolves normally | Must require a successful COMMIT result, not only absence of an error |
| Cursor header, step_begin and one row, then clean EOF without step_end | `all()` returns that row normally | Incomplete context can become a financial decision input |
| Fetch throws after atomic batch submission | One call, original error, no SDK retry | Error remains uncertain; one call does not establish non-application |

A strict boundary must validate exact request/result counts, result tags, required fields, step completion, integer/value shapes, batons and URLs. Pipeline-only execution avoids the tested cursor defect, but still requires a new strict validator; calling the existing `Session.sequence` is insufficient. `get_autocommit` reports whether a transaction is currently open; it is **not a commit receipt**, and the SDK resets it optimistically after some network errors. [Sequence and cursor processing](https://github.com/tursodatabase/turso/blob/d064d97544f940e7198e4635f8c9212bf80385a0/serverless/javascript/src/session.ts).

Proposed classification after this boundary exists:

| Evidence | Application result |
| --- | --- |
| Invalid input/encoding before submission; rejected asynchronous decision before writes | Confirmed not applied |
| Validated explicit transaction; no COMMIT ever submitted; staged work abandoned/rolled back | Confirmed not committed under that protocol; preserve original decision FinError |
| Complete structured guard rejection or known busy/conflict rejection, with transaction non-commit/rollback established | CONFLICT; no automatic retry |
| Complete non-committing schema/SQL rejection | Appropriate SCHEMA_INCOMPATIBLE or STORAGE_FAILURE |
| Write-batch/COMMIT submitted, then timeout, abort, redirect, generic HTTP error, invalid JSON, missing result, truncated body, or lost acknowledgement | OUTCOME_UNKNOWN unless affirmative evidence proves non-application |
| Complete validated successful COMMIT, followed only by cleanup failure | Keep the committed result; cleanup failure cannot turn it into not-applied |

These are protocol design rules, not a claim that every hosted error code is already known. The protocol explicitly warns that a whole-request failure can discard results **after committed writes**, even though any still-open transaction is rolled back. A timeout does not prove rollback; a later close or missing baton cannot undo a prior commit. Do not retry COMMIT, batch, or decision; a history lookup can aid reconciliation but is not a reason to silently replay. [Protocol failure semantics §§5.3,9](https://github.com/tursodatabase/turso/blob/d064d97544f940e7198e4635f8c9212bf80385a0/serverless/PROTOCOL.md#53-execution-model), [fin errors](https://github.com/iianjun/fin/blob/365d21e485586fded76c284e959fee27435d0431/packages/provider/src/errors.ts).

## Schema, exact history, integers and preparation

The existing fin schema needs composite primary/foreign keys and cascades, uniqueness including an expression index, CHECK/typeof/json_valid, UPSERT, category paths and stable history ordering. The release-source compatibility matrix lists ordinary tables, CHECK, indexes, views and UPSERT, and the relevant scalar/JSON functions, but **says WITH RECURSIVE is unsupported**. The newer main snapshot lists it supported. The existing recursive `fin_category_paths` view must therefore not be copied on the strength of current-main docs. A bounded three-level join view or JavaScript path projection is an alternative to validate; either requires explicit migration identity appropriate to the resulting asset. No financial decision needs to move into SQL. [fin schema](https://github.com/iianjun/fin/blob/365d21e485586fded76c284e959fee27435d0431/packages/sqlite/src/storage/schema.ts), [release COMPAT](https://github.com/tursodatabase/turso/blob/d064d97544f940e7198e4635f8c9212bf80385a0/COMPAT.md#statements), [newer COMPAT](https://github.com/tursodatabase/turso/blob/9b71df9abfd5bef3ee3c157f7ffef57fa2ce49ba/COMPAT.md#statements).

Specific compound FK/cascade behavior, expression-index collation/null behavior, query plans and category-view semantics still need exact-SQL tests against the selected hosted engine. The release matrix marks `foreign_keys` and `table_info` supported but `foreign_key_check` and `defer_foreign_keys` unsupported; do not build preparation around those unsupported PRAGMAs. Verify enforcement on each actual operation stream before depending on constraints. [Release PRAGMA matrix](https://github.com/tursodatabase/turso/blob/d064d97544f940e7198e4635f8c9212bf80385a0/COMPAT.md#pragma).

Protocol integer values are signed-64-bit decimal strings. The SDK encodes safe JS integers as integer strings, BigInt within signed 64-bit exactly, unsafe Number values as floats, and by default decodes integer strings with parseInt. `defaultSafeIntegers(true)` or statement `safeIntegers(true)` returns BigInt for integer **columns**. It does not preserve `lastInsertRowid`, which the release converts with parseInt regardless of safe mode. There is no main Config integer-string mode. Validate every decoded financial amount as a safe integer before converting to the provider's number type; keep revision/generation IDs text and stamp/order values as validated decimal text or BigInt. The executed probe confirmed default decoding loses precision at 9007199254740993. [Release value encoding](https://github.com/tursodatabase/turso/blob/d064d97544f940e7198e4635f8c9212bf80385a0/serverless/javascript/src/protocol.ts), [rowid conversion](https://github.com/tursodatabase/turso/blob/d064d97544f940e7198e4635f8c9212bf80385a0/serverless/javascript/src/session.ts).

History should persist the **exact supplied ChangeRecord payload**, including its before/after snapshots and revision strings, in the same transaction as domain changes. Existing fin reads history ordered by SQL rowid. Verify this ordering across updates/deletes/rollback and independent writers; do not substitute timestamps or opaque record-ID lexical order. Avoid using lossy `lastInsertRowid` as an ordering receipt. If an explicit sequence is selected instead, bind its exact representation and make its allocation part of the atomic commit. [ChangeRecord persistence](https://github.com/iianjun/fin/blob/365d21e485586fded76c284e959fee27435d0431/packages/sqlite/src/storage/changes.ts), [history projection](https://github.com/iianjun/fin/blob/365d21e485586fded76c284e959fee27435d0431/packages/sqlite/src/storage/context.ts#L126).

Ordinary initial preparation is feasible SQL work, not database provisioning. Proposed behavior: on first use, inspect the fin namespace and table-based migration identity; initialize an empty namespace in one owned transaction, install only the supported exact assets and ledger, and verify required objects/columns. With opt-out, verify and reject missing/incompatible schema without creating it. Unknown, partial or changed identities must fail, never be overwritten. Serialize local readiness callers and test independent-process initializers; after a confirmed competing initializer wins, re-read and verify without replaying migration writes. After an uncertain preparation commit, report uncertainty and reconcile rather than automatically rerunning DDL. [Existing schema manager](https://github.com/iianjun/fin/blob/365d21e485586fded76c284e959fee27435d0431/packages/sqlite/src/storage/migrations.ts), [D1 preparation](https://github.com/iianjun/fin/blob/365d21e485586fded76c284e959fee27435d0431/packages/d1/src/adapter.ts#L260).

Cloud documents read-only user_version/application_id and service-managed busy_timeout/journal_mode; keep a fin migration ledger table, not a PRAGMA version flag. Do not automatically enable MVCC by copying a local-file example. Drizzle may help SQL assembly only if the actual pinned integration works; it is unnecessary for this protocol and cannot repair transport or transaction semantics. [Cloud limitations](https://docs.turso.tech/cloud/limitations), [SDK comparison](https://docs.turso.tech/sdk/ts/reference).

## Runtime and verification boundary

Zero runtime npm dependencies does not mean fetch is the only global required. The released code also uses AbortSignal.timeout when configured, TextDecoder, readable-stream readers, atob and **Buffer** on blob paths. A probe with Buffer absent made a blob bind throw. ESM/CJS imports and basic fabricated-response operations ran on Node 24.18.0; no Worker, Deno, browser, packed TypeScript consumer, real HTTP server, local Turso engine, or hosted remote conformance was run. This report makes no support promise for them. Choose one intended runtime and run its import, types, timeout, stream and value paths; no mandatory Node-plus-Worker pair is justified. [Release manifest](https://github.com/tursodatabase/turso/blob/d064d97544f940e7198e4635f8c9212bf80385a0/serverless/javascript/package.json), [release runtime globals](https://github.com/tursodatabase/turso/blob/d064d97544f940e7198e4635f8c9212bf80385a0/serverless/javascript/src/protocol.ts).

### Reproducible minimal malformed-response probes

Run in a temporary directory after downloading/extracting the pinned tarball. This mocks HTTP entirely: it executes no database SQL.

```js
import assert from 'node:assert/strict'
import { connect } from './package/dist/index.js'

const savedFetch = globalThis.fetch
try {
  let submissions = 0
  globalThis.fetch = async () => {
    submissions++
    return Response.json({ baton: null, base_url: null })
  }
  const db = connect({ url: 'https://not-contacted.invalid' })
  assert.equal(submissions, 0)
  const result = await db.transactionAsync(async tx => {
    assert.equal(tx.open, true)
    return 'SDK reports success'
  }).immediate()
  assert.equal(result, 'SDK reports success')
  assert.equal(submissions, 2) // BEGIN and COMMIT, both missing results

  globalThis.fetch = async () => Response.json({
    baton: null, base_url: null,
    results: [{
      type: 'ok',
      response: { type: 'batch', result: {
        step_results: [null, { cols: [], rows: [], affected_row_count: 1 }, null, null],
        step_errors: [null, null, null, null],
      } },
    }, { type: 'ok', response: { type: 'get_autocommit', is_autocommit: true } }],
  })
  assert.equal((await connect({ url: 'https://not-contacted.invalid' })
    .batch(['INSERT INTO fake_table VALUES (1)'], 'immediate')).length, 1)

  globalThis.fetch = async () => new Response([
    JSON.stringify({ baton: null, base_url: null }),
    JSON.stringify({ type: 'step_begin', step: 0, cols: [{ name: 'n', decltype: 'INTEGER' }] }),
    JSON.stringify({ type: 'row', row: [{ type: 'integer', value: '7' }] }),
  ].join('\n') + '\n')
  assert.deepEqual(await connect({ url: 'https://not-contacted.invalid' })
    .all('SELECT n FROM fake_table'), [{ n: 7 }])
} finally {
  globalThis.fetch = savedFetch
}
```

Additional executed assertions checked unused close without fetch, omitted redirect options, exactly one lost-response batch submission, safe/unsafe integer encoding, exact BigInt decoding and missing Buffer behavior. No engine atomicity, rollback, locks, timeouts or durability was established by these probes.

### Remaining acceptance gates and user decisions

1. Choose fixed/patched SDK ownership versus an adapter-owned v3 transport; define public constructor/preparation/close ergonomics separately. No safe unmodified 1.4.1 implementation was identified.
2. Confirm the selected hosted engine/build supports the exact schema and session constraints, or choose validated replacement SQL assets and a new migration identity.
3. Verify independent-client IMMEDIATE isolation, snapshot consistency, missing-row/name/duplicate predicates, authoritative guards, conflict/error codes, expiry, and replica routing. Use these results to retain interactive transactions or select snapshot-plus-guard.
4. Run the shared financial/storage contract, one synchronous decision, unchanged behavior, exact history/revisions, safe integer boundaries and migration race/rollback checks.
5. Inject late constraint failure, failed rollback, real commit with lost acknowledgement, malformed/truncated responses, redirects and concurrent calls. Require complete rollback or OUTCOME_UNKNOWN, one submission and no decision replay.
6. Verify the chosen actual runtime and installed package shape; hosted credentials/provisioning and live checks are later explicitly scoped work.

Only this research report is added. No implementation functions, hooks, components, package or runtime files were created in the repository. The report hides no executable complexity; it records release evidence, protocol alternatives and the concrete gates for the next design decision.
