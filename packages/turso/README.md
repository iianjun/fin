# Turso adapter

Provisional `@fin/turso` targets the new Turso Database engine on Node **24.x**, using the official **`@tursodatabase/serverless@1.4.1`** SDK. The package exposes `createTursoAdapter` and its options type. It has no fin-owned HTTP protocol, SDK fork, patch, custom fetch option or public transport entrypoint.

**SDK-based hosted verification is pending.** Earlier actual-service results used a removed custom protocol implementation and do not certify this SDK path. Known SDK transport/response-validation limitations remain upstream responsibilities; fin does not replace the SDK to work around them. See [implementation and current evidence](https://github.com/iianjun/fin/issues/44).

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

Construction validates options synchronously and performs no network I/O. `url` is an HTTPS origin; `authToken` is nonempty. `autoMigrate` defaults to true; false checks compatibility on ordinary use, while explicit `migrate()` prepares an empty namespace. Unknown, partial or incompatible fin assets fail without destructive repair. Schema identity compares migration identity and exact catalog SQL tokens, allowing inter-token whitespace only. Similar SQLite/D1 schemas do not imply interoperability.

Each operation owns one official SDK Session. It enables/checks foreign keys before BEGIN IMMEDIATE, loads complete Vault dependencies, invokes the core decision synchronously once, and persists the supplied financial state, revisions and exact Change Record. The SDK's public batch API supplies raw bigint rows; application rows and mutation plans are validated with pinned **Zod 4.6.7**. Reads also use IMMEDIATE, so writer contention and network round trips are deliberate initial costs.

Unchanged/domain-failed decisions write no financial state or history. Async/nested decisions are rejected. The adapter does not retry decisions or submissions. An SDK error during COMMIT is `OUTCOME_UNKNOWN`; inspect state/history independently before submitting a new operation. Public errors omit raw SDK messages, SQL and credentials. `close()` stops admission, drains admitted operations, and closes their SDK sessions idempotently; cleanup does not change the financial outcome.

`timeoutMs` (1–60000, default 10000) configures the SDK's default query timeout, not an independent fin HTTP/body/close deadline. HTTP redirect behavior, next-request routing, baton lifecycle, wire decoding and malformed-response handling belong to the SDK. The current SDK's missing explicit redirect control, malformed-response handling and best-effort close limits are known support constraints. Strict malformed-wire/no-redirect guarantees are not claimed until upstream supports them and the SDK path is verified. No SDK source or global fetch is patched in production.

## Verification

```sh
pnpm check
pnpm test:turso:hosted
```

Local tests run the **actual installed SDK** against a SQLite-backed HTTP peer, the shared public financial/tools contract, storage rollback/history/concurrency/lifecycle checks and independently packed JS/TS consumers. Test-only fetch dispatch isolates peers and injects failures; it is not production transport code or actual-engine evidence. Existing SQLite/D1/stdio/Worker regressions remain in scope. No new-adapter Worker or other-runtime support is claimed.

The explicit hosted command requires a dedicated disposable new-engine database and never provisions services or treats missing credentials as a pass. Set `TURSO_TEST_URL`, `TURSO_TEST_AUTH_TOKEN`, `TURSO_TEST_DEDICATED_NEW_ENGINE=1`, and `TURSO_TEST_ENGINE_METADATA` through the environment. The command runs the public financial/tools and SDK storage checks with run-owned isolated namespaces and independent cleanup. Record fresh implementation/runtime/dependency/server metadata and results in #44 before making a support claim. Previous custom-protocol probes and results are obsolete for this implementation.
