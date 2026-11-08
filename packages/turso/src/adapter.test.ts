import { afterEach, expect, test, vi } from 'vitest'
import { createFin, createVault, listVaults, FinError } from '@fin/core'
import { createTursoAdapter } from './adapter.js'
import { openTursoFixture } from '../test/fixture.js'

const fixtures: ReturnType<typeof openTursoFixture>[] = []
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.dispose()
})
async function fixture() {
  const f = openTursoFixture()
  fixtures.push(f)
  const { vault } = await createVault({ storage: f.storage, name: 'Household' })
  return { ...f, vault, fin: createFin({ storage: f.storage, vaultId: vault.id }) }
}

test('validates synchronously without I/O and closes unused instances idempotently', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>()
  const storage = createTursoAdapter({ url: 'https://db.invalid', authToken: 'unused', fetch })
  expect(fetch).not.toHaveBeenCalled()
  const close = storage.close()
  expect(storage.close()).toBe(close)
  await close
  expect(fetch).not.toHaveBeenCalled()
  for (const options of [
    null,
    {},
    { url: 'libsql://db.invalid', authToken: 'secret' },
    { url: 'https://db.invalid', authToken: 'unused', autoMigrate: 'yes' },
  ]) {
    expect(() => createTursoAdapter(JSON.parse(JSON.stringify(options)))).toThrowError(
      expect.objectContaining({ code: 'INVALID_INPUT' }),
    )
  }
  await expect(storage.migrate()).rejects.toMatchObject({ code: 'STORAGE_FAILURE' })
})

test('explicit migration, opt-out verification and unrelated host data preservation', async () => {
  const f = openTursoFixture({ autoMigrate: false })
  fixtures.push(f)
  f.database.exec("CREATE TABLE host_data(value TEXT); INSERT INTO host_data VALUES ('keep')")
  await expect(listVaults({ storage: f.storage })).rejects.toMatchObject({
    code: 'SCHEMA_INCOMPATIBLE',
  })
  expect(
    f.database.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'fin_%'").all(),
  ).toEqual([])
  await f.storage.migrate()
  await f.storage.migrate()
  const created = await createVault({ storage: f.storage, name: 'Ready' })
  expect(await listVaults({ storage: f.client({ autoMigrate: false }) })).toEqual([created.vault])
  expect(f.database.prepare('SELECT value FROM host_data').get()).toEqual({ value: 'keep' })
})

test.each(['version', 'identity', 'partial', 'unknown', 'view', 'index', 'trigger', 'column'])(
  'rejects %s schema drift even after successful readiness, without repairing data',
  async (kind) => {
    const f = await fixture()
    const mutations: Record<string, string> = {
      version: 'UPDATE fin_migrations SET version=999',
      identity: "UPDATE fin_migrations SET identity='other-adapter'",
      partial: 'DROP TABLE fin_transaction_relations',
      unknown: 'CREATE TABLE fin_unknown(value TEXT)',
      view: 'DROP VIEW fin_category_paths; CREATE VIEW fin_category_paths AS SELECT 1 AS path',
      index: 'DROP INDEX fin_category_siblings',
      trigger: 'CREATE TRIGGER host_trigger AFTER INSERT ON fin_accounts BEGIN SELECT 1; END',
      column: 'ALTER TABLE fin_accounts ADD COLUMN unexpected TEXT',
    }
    const sql = mutations[kind]
    if (!sql) throw new Error('Missing test mutation')
    f.database.exec(sql)
    const before = f.database.prepare('SELECT * FROM fin_vaults').all()
    await expect(createVault({ storage: f.storage, name: 'Blocked' })).rejects.toMatchObject({
      code: 'SCHEMA_INCOMPATIBLE',
      application: 'not_applied',
    })
    await expect(f.storage.migrate()).rejects.toMatchObject({ code: 'SCHEMA_INCOMPATIBLE' })
    expect(f.database.prepare('SELECT * FROM fin_vaults').all()).toEqual(before)
  },
)

test('accepts real Turso catalog whitespace formatting while preserving schema identity', async () => {
  const f = await fixture()
  const storage = f.client({
    fetch: async (input, init) => {
      const response = await f.fetch(input, init)
      if (!String(init?.body).includes('FROM sqlite_schema')) return response
      const body = await response.json()
      for (const row of body.results[0].response.result.rows) {
        const value = row[2]
        if (value.type !== 'text') continue
        // Captured formatting differences from the actual hosted new engine.
        value.value = value.value
          .replaceAll('CHECK(', 'CHECK (')
          .replaceAll('PRIMARY KEY(', 'PRIMARY KEY (')
          .replaceAll('UNIQUE(', 'UNIQUE (')
          .replaceAll('fin_vaults(id)', 'fin_vaults (id)')
          .replaceAll('vaultId,id', 'vaultId, id')
          .replaceAll('\n', ' ')
      }
      return Response.json(body)
    },
  })
  await storage.migrate()
  expect(await listVaults({ storage })).toEqual([f.vault])
  const fin = createFin({ storage, vaultId: f.vault.id })
  const account = (await fin.createAccount({ name: 'Cash', nature: 'asset', currency: 'KRW' }))
    .account
  expect(await fin.getAccount({ id: account.id })).toEqual(account)
})

test.each([
  'literal-whitespace',
  'word-boundary',
  'operator-boundary',
  'numeric-constraint',
  'comment',
])('catalog formatting tolerance still rejects %s changes', async (fault) => {
  const f = await fixture()
  const storage = f.client({
    fetch: async (input, init) => {
      const response = await f.fetch(input, init)
      if (!String(init?.body).includes('FROM sqlite_schema')) return response
      const body = await response.json()
      for (const row of body.results[0].response.result.rows) {
        const value = row[2]
        if (value.type !== 'text') continue
        if (fault === 'literal-whitespace') value.value = value.value.replaceAll("' / '", "'  /  '")
        if (fault === 'word-boundary')
          value.value = value.value.replaceAll('PRIMARY KEY', 'PRIMARYKEY')
        if (fault === 'operator-boundary') value.value = value.value.replaceAll('||', '| |')
        if (fault === 'numeric-constraint')
          value.value = value.value.replaceAll('9007199254740991', '9007199254740990')
        if (fault === 'comment')
          value.value = value.value.replaceAll('NOT NULL', 'NOT /*changed*/ NULL')
      }
      return Response.json(body)
    },
  })
  await expect(storage.read({ kind: 'vaults' })).rejects.toMatchObject({
    code: 'SCHEMA_INCOMPATIBLE',
  })
  expect(await listVaults({ storage: f.storage })).toEqual([f.vault])
})

test('partial initial migration rolls back and can subsequently prepare normally', async () => {
  const f = openTursoFixture()
  fixtures.push(f)
  let fail = true
  const storage = f.client({
    fetch: async (input, init) => {
      if (fail && String(init?.body).includes('INSERT INTO fin_migrations')) {
        fail = false
        const body = JSON.parse(String(init?.body))
        body.requests[0].stmt.args[0] = { type: 'null' }
        return f.fetch(input, { ...init, body: JSON.stringify(body) })
      }
      return f.fetch(input, init)
    },
  })
  await expect(storage.migrate()).rejects.toMatchObject({
    code: 'STORAGE_FAILURE',
    application: 'not_applied',
  })
  expect(
    f.database.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'fin_%'").all(),
  ).toEqual([])
  await storage.migrate()
  expect(await listVaults({ storage })).toEqual([])
})

test('simultaneous independent preparation does not create partial schemas or replay a failed call', async () => {
  const f = openTursoFixture()
  fixtures.push(f)
  const outcomes = await Promise.allSettled([f.storage.migrate(), f.client().migrate()])
  expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
  expect(outcomes.find((r) => r.status === 'rejected')).toMatchObject({
    reason: { code: 'STORAGE_FAILURE' },
  })
  expect(f.submissions.filter((s) => s.sql === 'BEGIN IMMEDIATE')).toHaveLength(2)
  await f.client({ autoMigrate: false }).migrate()
  expect(f.database.prepare('SELECT count(*) AS n FROM fin_migrations').get()).toEqual({ n: 1 })
})

test('calls one synchronous decision, preserves its result and exact supplied revisions/history', async () => {
  const f = await fixture()
  const record = {
    id: 'supplied-history',
    vaultId: f.vault.id,
    target: 'vault',
    targetId: f.vault.id,
    action: 'updated',
    recordedAt: '2026-11-08T01:02:03.000Z',
    before: f.vault,
    after: { ...f.vault, revision: 'supplied-revision', name: '한글\u0000🙂' },
    balances: [],
  } satisfies import('@fin/core').ChangeRecord
  const result = { opaque: Symbol('same result') }
  const decide = vi.fn(
    () => ({ kind: 'changed', changes: { vault: record.after }, record, result }) as const,
  )
  expect(await f.storage.mutate({ kind: 'vault', vaultId: f.vault.id }, decide)).toBe(result)
  expect(decide).toHaveBeenCalledTimes(1)
  expect(await f.fin.getVault()).toEqual(record.after)
  expect(await f.fin.listChangeRecords({ targetId: f.vault.id })).toEqual([
    expect.objectContaining({ action: 'created' }),
    record,
  ])
  expect(
    f.database.prepare('SELECT payload FROM fin_change_records WHERE id=?').get(record.id),
  ).toEqual({ payload: JSON.stringify(record) })
})

test('unchanged and failed decisions do not write state, revisions or history', async () => {
  const f = await fixture()
  const before = await f.fin.listChangeRecords()
  const count = f.submissions.length
  await expect(
    f.storage.mutate({ kind: 'vault', vaultId: f.vault.id }, () => ({
      kind: 'unchanged',
      result: 42,
    })),
  ).resolves.toBe(42)
  const domain = new FinError('CONFLICT', 'Stale revision.', 'Read latest state.')
  await expect(
    f.storage.mutate({ kind: 'vault', vaultId: f.vault.id }, () => {
      throw domain
    }),
  ).rejects.toBe(domain)
  expect(f.submissions.slice(count).some((s) => /^(INSERT|UPDATE|DELETE)/.test(s.sql))).toBe(false)
  expect(await f.fin.listChangeRecords()).toEqual(before)
})

test.each(['read', 'mutate', 'migrate', 'close', 'async'])(
  'rejects %s nesting and async decisions, including swallowed calls and later continuations',
  async (kind) => {
    const f = await fixture()
    const before = await f.fin.listChangeRecords()
    const nested: Promise<unknown>[] = []
    if (kind === 'async') {
      await expect(
        f.storage.mutate(
          { kind: 'vault', vaultId: f.vault.id },
          // @ts-expect-error Runtime callers can supply invalid async decisions.
          async () => {
            await Promise.resolve()
            nested.push(f.storage.read({ kind: 'vaults' }))
            return { kind: 'unchanged', result: 1 }
          },
        ),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    } else {
      await expect(
        f.storage.mutate({ kind: 'vault', vaultId: f.vault.id }, () => {
          nested.push(
            kind === 'read'
              ? f.storage.read({ kind: 'vaults' })
              : kind === 'migrate'
                ? f.storage.migrate()
                : kind === 'close'
                  ? f.storage.close()
                  : f.storage.mutate({ kind: 'createVault' }, () => ({
                      kind: 'unchanged',
                      result: 0,
                    })),
          )
          return { kind: 'unchanged', result: 1 }
        }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    }
    await Promise.resolve()
    expect(nested).toHaveLength(1)
    await expect(nested[0]).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(await f.fin.listChangeRecords()).toEqual(before)
  },
)

test.each(['edit', 'delete', 'classify', 'adjust'])(
  'rolls back late %s failure after real state writes and preserves every revision and history row',
  async (operation) => {
    const f = await fixture()
    const account = (await f.fin.createAccount({ name: 'Cash', nature: 'asset', currency: 'KRW' }))
      .account
    const t = (
      await f.fin.recordIncomeExpense({ kind: 'expense', accountId: account.id, amountMinor: 500 })
    ).transaction
    const category = (await f.fin.createCategory({ name: 'Food' })).category
    const before = await f.fin.getAccount({ id: account.id })
    const records = await f.fin.listChangeRecords()
    const storage = f.client({
      fetch: async (input, init) => {
        const body = JSON.parse(String(init?.body))
        for (const r of body.requests)
          if (r.stmt?.sql.startsWith('INSERT INTO fin_change_records'))
            r.stmt.args[1] = { type: 'text', value: records[0]?.id }
        return f.fetch(input, { ...init, body: JSON.stringify(body) })
      },
    })
    const fin = createFin({ storage, vaultId: f.vault.id })
    const input = { id: t.id, expectedRevision: t.revision }
    const pending =
      operation === 'edit'
        ? fin.editTransaction({ ...input, patch: { amountMinor: 1000 } })
        : operation === 'delete'
          ? fin.deleteTransaction(input)
          : operation === 'classify'
            ? fin.setCategoryAssignments({
                ...input,
                assignments: [{ categoryId: category.id, amountMinor: 500, origin: 'explicit' }],
              })
            : fin.adjustAccountBalance({
                accountId: account.id,
                expectedRevision: before.balanceRevision,
                targetBalanceMinor: 0,
              })
    await expect(pending).rejects.toMatchObject({
      code: 'STORAGE_FAILURE',
      application: 'not_applied',
    })
    expect(await f.fin.getTransaction({ id: t.id })).toEqual(t)
    expect(await f.fin.getAccount({ id: account.id })).toEqual(before)
    expect(await f.fin.listChangeRecords()).toEqual(records)
  },
)

test('lost acknowledgement of a real COMMIT returns OUTCOME_UNKNOWN with one decision and no replay', async () => {
  const f = await fixture()
  let commits = 0
  const storage = f.client({
    fetch: async (input, init) => {
      const response = await f.fetch(input, init)
      if (String(init?.body).includes('"sql":"COMMIT"')) {
        commits++
        const body = await response.clone().json()
        expect(body.results[0].type).toBe('ok')
        throw new Error('lost successful receipt')
      }
      return response
    },
  })
  const result = { ...f.vault, name: 'Committed', revision: 'ack-lost' }
  const record = {
    id: 'ack-lost',
    vaultId: f.vault.id,
    target: 'vault',
    targetId: f.vault.id,
    action: 'updated',
    recordedAt: '2026-11-08',
    before: f.vault,
    after: result,
    balances: [],
  } satisfies import('@fin/core').ChangeRecord
  const decide = vi.fn(
    () => ({ kind: 'changed', changes: { vault: result }, record, result }) as const,
  )
  await expect(
    storage.mutate({ kind: 'vault', vaultId: f.vault.id }, decide),
  ).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN', application: 'unknown' })
  expect(decide).toHaveBeenCalledTimes(1)
  expect(commits).toBe(1)
  expect(await f.fin.getVault()).toEqual(result)
  expect(await f.fin.listChangeRecords({ targetId: f.vault.id })).toContainEqual(record)
})

test('close drains readiness and decision work admitted before closing, rejects later work', async () => {
  const f = await fixture()
  let enter = () => {}
  let release = () => {}
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  const resume = new Promise<void>((resolve) => {
    release = resolve
  })
  const storage = f.client({
    fetch: async (input, init) => {
      if (String(init?.body).includes('FROM fin_vaults WHERE id')) {
        enter()
        await resume
      }
      return f.fetch(input, init)
    },
  })
  const decide = vi.fn(() => ({ kind: 'unchanged', result: 7 }) as const)
  const work = storage.mutate({ kind: 'vault', vaultId: f.vault.id }, decide)
  await entered
  const close = storage.close()
  expect(storage.close()).toBe(close)
  let closed = false
  void close.then(() => {
    closed = true
  })
  await expect(storage.read({ kind: 'vaults' })).rejects.toMatchObject({ code: 'STORAGE_FAILURE' })
  await expect(storage.migrate()).rejects.toMatchObject({ code: 'STORAGE_FAILURE' })
  expect(closed).toBe(false)
  release()
  expect(await work).toBe(7)
  expect(decide).toHaveBeenCalledTimes(1)
  await close
  expect(closed).toBe(true)
})

test('rejects unsafe stored history and aggregate balances instead of rounding', async () => {
  const f = await fixture()
  const a = (await f.fin.createAccount({ name: 'Cash', nature: 'asset', currency: 'KRW' })).account
  await f.fin.recordIncomeExpense({
    kind: 'income',
    accountId: a.id,
    amountMinor: Number.MAX_SAFE_INTEGER,
  })
  f.database
    .prepare(
      "INSERT INTO fin_transactions (vaultId,id,revision,kind,occurredOn,accountId,amountMinor) VALUES (?,'extra','r','income','2026-11-08',?,1)",
    )
    .run(f.vault.id, a.id)
  await expect(f.fin.getAccount({ id: a.id })).rejects.toMatchObject({ code: 'STORAGE_FAILURE' })
  f.database.prepare("DELETE FROM fin_transactions WHERE id='extra'").run()
  f.database
    .prepare(
      'UPDATE fin_change_records SET payload=? WHERE id=(SELECT id FROM fin_change_records LIMIT 1)',
    )
    .run('{"balances":[{"resultingBalanceMinor":9007199254740992}]}')
  await expect(f.fin.listChangeRecords()).rejects.toMatchObject({ code: 'STORAGE_FAILURE' })
})

test.each([
  'missing-column',
  'combined-columns',
  'unsafe-integer',
  'bad-boolean',
  'malformed-history',
  'zero-write',
])('fails closed on %s context/write receipts before committing a mutation', async (fault) => {
  const f = await fixture()
  const a = (await f.fin.createAccount({ name: 'Cash', nature: 'asset', currency: 'KRW' })).account
  const before = await f.fin.listChangeRecords()
  const decide = vi.fn(() => ({ kind: 'unchanged', result: 1 }) as const)
  const storage = f.client({
    fetch: async (input, init) => {
      const response = await f.fetch(input, init)
      const body = await response.json()
      const sql = JSON.parse(String(init?.body)).requests[0]?.stmt?.sql ?? ''
      const result = body.results[0]?.response?.result
      if (fault === 'missing-column' && sql.includes('FROM fin_accounts')) result.cols.pop()
      if (fault === 'combined-columns' && sql.includes('FROM fin_accounts')) {
        result.cols = [
          { name: result.cols.map((col: { name: string }) => col.name).join(','), decltype: null },
        ]
        result.rows = []
      }
      if (fault === 'unsafe-integer' && sql.includes('FROM fin_accounts'))
        result.rows[0][0] = { type: 'integer', value: '9007199254740992' }
      if (fault === 'bad-boolean' && sql.includes('FROM fin_accounts'))
        result.rows[0][6] = { type: 'integer', value: '2' }
      if (fault === 'malformed-history' && sql.includes('FROM fin_change_records'))
        result.rows[0][2] = { type: 'text', value: '{}' }
      if (fault === 'zero-write' && sql.startsWith('INSERT INTO fin_accounts'))
        result.affected_row_count = 0
      return Response.json(body)
    },
  })
  const fin = createFin({ storage, vaultId: f.vault.id })
  const pending =
    fault === 'malformed-history'
      ? fin.listChangeRecords()
      : fault === 'zero-write'
        ? fin.updateAccount({
            id: a.id,
            expectedRevision: a.revision,
            patch: { name: 'Rejected' },
          })
        : storage.mutate({ kind: 'transaction', vaultId: f.vault.id }, decide)
  await expect(pending).rejects.toMatchObject({ code: 'STORAGE_FAILURE' })
  expect(decide).not.toHaveBeenCalled()
  expect(await f.fin.getAccount({ id: a.id })).toEqual(a)
  expect(await f.fin.listChangeRecords()).toEqual(before)
})

test('hosted fixture rewrites only owned SQL identifiers/metadata and cleans its namespace', async () => {
  const f = openTursoFixture()
  fixtures.push(f)
  vi.stubGlobal('fetch', f.fetch)
  vi.stubEnv('TURSO_TEST_URL', 'https://db.invalid')
  vi.stubEnv('TURSO_TEST_AUTH_TOKEN', 'unused')
  vi.stubEnv('TURSO_TEST_DEDICATED_NEW_ENGINE', '1')
  vi.stubEnv('TURSO_TEST_ENGINE_METADATA', 'local wrapper test only; no actual Turso evidence')
  const { openHostedTursoFixture } = await import('../test/hosted-fixture.js')
  try {
    const hosted = await openHostedTursoFixture()
    try {
      const { vault } = await createVault({ storage: hosted.storage, name: 'Literal fin_ text' })
      const fin = createFin({ storage: hosted.storage, vaultId: vault.id })
      const a = (
        await fin.createAccount({ name: 'fin_accounts', nature: 'asset', currency: 'KRW' })
      ).account
      const t = (
        await fin.recordIncomeExpense({
          kind: 'income',
          accountId: a.id,
          amountMinor: 1,
          memo: 'fin_ bound data',
        })
      ).transaction
      expect(await fin.getTransaction({ id: t.id })).toEqual(t)
      expect((await fin.listChangeRecords({ targetId: t.id }))[0]?.after).toMatchObject({
        transaction: t,
      })
      expect(
        f.database.prepare("SELECT name FROM sqlite_schema WHERE name='fin_vaults'").all(),
      ).toEqual([])
    } finally {
      await hosted.dispose()
    }
    expect(
      f.database.prepare("SELECT name FROM sqlite_schema WHERE substr(name,1,4)='fin_'").all(),
    ).toEqual([])
  } finally {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  }
})
