import { afterEach, describe, expect, test, vi } from 'vitest'
import { createFin, createVault, listVaults } from '@fin-kit/core'
import { createNeonAdapter } from '@fin-kit/neon'
import { createFinTools } from '@fin-kit/tools'
import type { ChangeRecord, MutationDecision } from '@fin-kit/provider'
import { openNeonFixture } from '../test/fixture.js'
import { openNeonProxy } from '../test/proxy.js'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

test('validates options synchronously and creates/closes without network I/O', async () => {
  expect(() => createNeonAdapter({ connectionString: ' ' })).toThrowError(
    expect.objectContaining({ code: 'INVALID_INPUT' }),
  )
  expect(() => createNeonAdapter({ connectionString: 'https://example.com' })).toThrowError(
    expect.objectContaining({ code: 'INVALID_INPUT' }),
  )
  const storage = createNeonAdapter({
    connectionString: 'postgres://user:private@127.0.0.1:1/missing',
  })
  const first = storage.close()
  expect(storage.close()).toBe(first)
  await first
  await expect(storage.read({ kind: 'vaults' })).rejects.toMatchObject({ code: 'STORAGE_FAILURE' })
})

describe.skipIf(!process.env.FIN_NEON_URL)('real Neon contract', () => {
  async function fixture() {
    const f = await openNeonFixture()
    cleanup.push(f.dispose)
    const { vault } = await createVault({ storage: f.storage, name: 'Household' })
    const fin = createFin({ storage: f.storage, vaultId: vault.id })
    const second = createNeonAdapter({ connectionString: f.connectionString })
    cleanup.push(second.close)
    return { ...f, vault, fin, second, other: createFin({ storage: second, vaultId: vault.id }) }
  }

  test.each(['password', 'username'] as const)(
    'rejects failed %s authentication before deciding and closes its native socket',
    async (field) => {
      const f = await openNeonFixture()
      cleanup.push(f.dispose)
      const proxy = await openNeonProxy(f.targetConnectionString)
      cleanup.push(proxy.dispose)
      const url = new URL(proxy.connectionString)
      url[field] = 'fin-intentionally-invalid-authentication'
      const storage = createNeonAdapter({ connectionString: url.toString() })
      cleanup.push(storage.close)
      const decide = vi.fn(() => ({ kind: 'unchanged' as const, result: null }))
      await expect(storage.mutate({ kind: 'createVault' }, decide)).rejects.toMatchObject({
        code: 'STORAGE_FAILURE',
        application: 'not_applied',
        message: 'The Neon operation failed.',
      })
      expect(decide).not.toHaveBeenCalled()
      await storage.close()
      expect(proxy.openClients).toBe(0)
    },
  )

  test('keeps each transaction on one native WebSocket session without retained session settings', async () => {
    const f = await fixture()
    const database = (await f.db.query<{ name: string }>('SELECT current_database() AS name'))
      .rows[0]?.name
    if (!database || !/^fin_neon_(?:[a-f0-9]{12}_)?[a-f0-9]{32}$/.test(database))
      throw new Error('Expected run-owned database')
    await f.db.query(`ALTER DATABASE "${database}" SET search_path = pg_catalog`)
    const statements: { sql: string; session: number }[] = []
    const proxy = await openNeonProxy(f.targetConnectionString, {
      beforeQuery(sql, session) {
        statements.push({ sql, session })
      },
    })
    cleanup.push(proxy.dispose)
    const storage = createNeonAdapter({
      connectionString: proxy.connectionString,
      autoMigrate: false,
    })
    cleanup.push(storage.close)
    await storage.read({ kind: 'vault', vaultId: f.vault.id })
    await storage.mutate({ kind: 'vault', vaultId: f.vault.id }, () => ({
      kind: 'unchanged',
      result: null,
    }))
    expect(proxy.sessions).toBe(1)
    expect(new Set(statements.map((entry) => entry.session)).size).toBe(1)
    const beginnings = statements.flatMap((entry, i) => (entry.sql.startsWith('BEGIN') ? [i] : []))
    expect(beginnings).toHaveLength(4) // preparation and financial transaction, twice
    for (const i of beginnings)
      expect(statements[i + 1]?.sql).toBe('SET LOCAL search_path = public, pg_catalog')
    const lock = statements.findIndex(({ sql }) => sql.includes('FOR UPDATE'))
    const dependencies = statements.findIndex(
      ({ sql }, i) => i > lock && sql.startsWith('SELECT id,name'),
    )
    expect(lock).toBeGreaterThan(0)
    expect(dependencies).toBeGreaterThan(lock)
    await storage.close()
    expect(proxy.openClients).toBe(0)
  })

  test('recovers on a fresh session after idle disconnect and discards a broken admitted write without replay', async () => {
    const f = await fixture()
    let fail = false,
      commits = 0,
      decisions = 0
    const proxy = await openNeonProxy(f.targetConnectionString, {
      beforeQuery(sql) {
        if (fail && sql.startsWith('INSERT INTO fin_change_records')) {
          fail = false
          throw new Error('disconnect before commit')
        }
        if (sql === 'COMMIT') commits++
      },
    })
    cleanup.push(proxy.dispose)
    const storage = createNeonAdapter({ connectionString: proxy.connectionString })
    cleanup.push(storage.close)
    await storage.read({ kind: 'vaults' })
    const first = proxy.sessions
    // Observe the actual native WebSocket close event and owned idle pool listener.
    await proxy.disconnect()
    expect((await storage.read({ kind: 'vaults' })).vaults).toEqual([f.vault])
    expect(proxy.sessions).toBeGreaterThan(first)
    const before = await f.fin.listChangeRecords()
    const record: ChangeRecord = {
      id: 'broken',
      vaultId: f.vault.id,
      target: 'vault',
      targetId: f.vault.id,
      action: 'updated',
      recordedAt: new Date().toISOString(),
      before: f.vault,
      after: { ...f.vault, name: 'Never committed' },
      balances: [],
    }
    commits = 0
    await expect(
      storage.mutate({ kind: 'vault', vaultId: f.vault.id }, () => {
        decisions++
        fail = true
        return {
          kind: 'changed',
          changes: { vault: { ...f.vault, name: 'Never committed' } },
          record,
          result: null,
        }
      }),
    ).rejects.toMatchObject({ code: 'STORAGE_FAILURE', application: 'not_applied' })
    expect(decisions).toBe(1)
    expect(commits).toBe(1) // preparation only; no financial COMMIT submitted
    await f.db.query('BEGIN')
    await f.db.query('SELECT id FROM fin_vaults WHERE id=$1 FOR UPDATE', [f.vault.id])
    await f.db.query('ROLLBACK')
    expect(await f.fin.getVault()).toEqual(f.vault)
    expect(await f.fin.listChangeRecords()).toEqual(before)
    const brokenSession = proxy.sessions
    expect((await storage.read({ kind: 'vaults' })).vaults).toEqual([f.vault])
    expect(proxy.sessions).toBeGreaterThan(brokenSession)
  })

  test('reads one repeatable snapshot across concurrent multi-table changes', async () => {
    const { targetConnectionString, fin, vault } = await fixture()
    const { account } = await fin.createAccount({ name: 'Cash', nature: 'asset', currency: 'KRW' })
    let resume = () => {},
      reached = () => {}
    const gate = new Promise<void>((resolve) => {
      resume = resolve
    })
    const paused = new Promise<void>((resolve) => {
      reached = resolve
    })
    const proxy = await openNeonProxy(targetConnectionString, {
      beforeQuery: async (sql) => {
        if (sql.startsWith('SELECT revision,"incomeAccountId"')) {
          reached()
          await gate
        }
      },
    })
    cleanup.push(proxy.dispose)
    const storage = createNeonAdapter({ connectionString: proxy.connectionString })
    cleanup.push(storage.close)
    const snapshot = storage.read({ kind: 'transactions', vaultId: vault.id })
    try {
      await paused
      await fin.recordIncomeExpense({ kind: 'income', accountId: account.id, amountMinor: 100 })
      await fin.updateVault({ expectedRevision: vault.revision, patch: { name: 'New name' } })
    } finally {
      resume()
    }
    const context = await snapshot
    expect(context.vault).toEqual(vault)
    expect(context.transactions).toEqual([])
    expect(context.accounts).toEqual([account])
    expect((await fin.getAccount({ id: account.id })).balanceMinor).toBe(100)
  })

  test('rolls back partially executed schema preparation after an actual connection loss', async () => {
    const f = await openNeonFixture()
    cleanup.push(f.dispose)
    await f.db.query("CREATE TABLE host_data(value text); INSERT INTO host_data VALUES ('keep')")
    let failed = false
    const proxy = await openNeonProxy(f.targetConnectionString, {
      afterCommand(command) {
        if (!failed && command === 'CREATE TABLE') {
          failed = true
          return 'disconnect'
        }
      },
    })
    cleanup.push(proxy.dispose)
    const storage = createNeonAdapter({ connectionString: proxy.connectionString })
    cleanup.push(storage.close)
    await expect(storage.migrate()).rejects.toMatchObject({ code: 'STORAGE_FAILURE' })
    await f.db.query('SELECT pg_advisory_lock(1718185521,1)')
    await f.db.query('SELECT pg_advisory_unlock(1718185521,1)')
    expect(
      (
        await f.db.query(
          "SELECT relname FROM pg_class WHERE relnamespace='public'::regnamespace AND left(relname,4)='fin_'",
        )
      ).rows,
    ).toEqual([])
    expect((await f.db.query('SELECT * FROM host_data')).rows).toEqual([{ value: 'keep' }])
    await f.storage.migrate()
    expect(await listVaults({ storage: f.storage })).toEqual([])
  })

  test('protects absence and parent dependencies after waiting for an existing Vault lock', async () => {
    const { targetConnectionString, fin, other, vault, db } = await fixture()
    const { category } = await fin.createCategory({ name: 'Parent' })
    let resume = () => {},
      reached = () => {}
    const gate = new Promise<void>((resolve) => {
      resume = resolve
    })
    const paused = new Promise<void>((resolve) => {
      reached = resolve
    })
    const proxy = await openNeonProxy(targetConnectionString, {
      beforeQuery: async (sql) => {
        if (sql.startsWith('SELECT id,name,revision,archived FROM fin_vaults WHERE id=')) {
          reached()
          await gate
        }
      },
    })
    cleanup.push(proxy.dispose)
    const storage = createNeonAdapter({ connectionString: proxy.connectionString })
    cleanup.push(storage.close)
    const writer = createFin({ storage, vaultId: vault.id })
    const archive = writer.updateCategory({
      id: category.id,
      expectedRevision: category.revision,
      patch: { archived: true },
    })
    await paused
    const child = other.createCategory({ name: 'Child', parentId: category.id })
    const outcomes = Promise.allSettled([archive, child])
    try {
      await expect
        .poll(
          async () =>
            (
              await db.query(
                "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FOR UPDATE%'",
              )
            ).rows[0]?.n,
          { timeout: 20000, interval: 100 },
        )
        .toBeGreaterThan(0)
    } finally {
      resume()
      await outcomes
    }
    const [archived, rejected] = await outcomes
    expect(archived).toMatchObject({ status: 'fulfilled' })
    expect(rejected).toMatchObject({ status: 'rejected', reason: { code: 'INVALID_INPUT' } })
    expect(await fin.listCategories({ includeArchived: true })).toHaveLength(1)
  })

  test('enforces safe integer encodings and rejects unsafe persisted aggregates', async () => {
    const { fin, db, vault } = await fixture()
    const { account } = await fin.createAccount({ name: 'Exact', nature: 'asset', currency: 'KRW' })
    await fin.recordIncomeExpense({
      kind: 'income',
      accountId: account.id,
      amountMinor: Number.MAX_SAFE_INTEGER,
    })
    expect((await fin.getAccount({ id: account.id })).balanceMinor).toBe(Number.MAX_SAFE_INTEGER)
    await expect(
      db.query(
        'INSERT INTO fin_transactions("vaultId",id,revision,kind,"occurredOn","accountId","amountMinor") VALUES ($1,$2,$2,\'income\',\'2026-11-12\',$3,$4)',
        [vault.id, 'unsafe', account.id, '9007199254740992'],
      ),
    ).rejects.toMatchObject({ code: '23514' })
    await db.query(
      'INSERT INTO fin_transactions("vaultId",id,revision,kind,"occurredOn","accountId","amountMinor") VALUES ($1,$2,$2,\'income\',\'2026-11-12\',$3,1)',
      [vault.id, 'aggregate', account.id],
    )
    await expect(fin.queryBalances()).rejects.toMatchObject({ code: 'STORAGE_FAILURE' })
  })

  test('round trips all JavaScript text through names, predicates, paths, memos and history', async () => {
    const { fin, other, vault } = await fixture()
    const values = [
      'value\u0000end',
      'value\\0end',
      'value\ud800end',
      'value\\ud800end',
      'value\udc00end',
      'value\\\\end',
      '한글😀éend',
    ]
    let currentVault = vault
    for (const value of values) {
      currentVault = (
        await fin.updateVault({ expectedRevision: currentVault.revision, patch: { name: value } })
      ).vault
      expect(await other.getVault()).toEqual(currentVault)
      const { account } = await fin.createAccount({ name: value, nature: 'asset', currency: 'USD' })
      expect(await other.getAccount({ id: account.id })).toEqual(account)
      await expect(
        other.createAccount({ name: value, nature: 'asset', currency: 'USD' }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
      const { category } = await fin.createCategory({ name: value })
      const { category: child } = await fin.createCategory({ name: 'Child', parentId: category.id })
      expect((await other.listCategories()).find((c) => c.id === child.id)?.path).toBe(
        `${value} / Child`,
      )
      await expect(other.createCategory({ name: value })).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      })
      const input = {
        kind: 'expense' as const,
        accountId: account.id,
        amountMinor: 5,
        memo: value,
        assignments: [{ categoryId: child.id, amountMinor: 5, origin: 'explicit' as const }],
      }
      const { transaction } = await fin.recordIncomeExpense(input)
      expect(await other.listTransactions({ search: value })).toEqual([transaction])
      expect(await other.listTransactions({ categoryId: category.id })).toEqual([transaction])
      await expect(other.recordIncomeExpense(input)).rejects.toMatchObject({
        code: 'DUPLICATE_CANDIDATE',
      })
      const history = await other.listChangeRecords({ targetId: transaction.id })
      expect(history).toHaveLength(1)
      expect(history[0]?.after).toMatchObject({ transaction, accounts: [{ name: value }] })
      expect(
        await other.editTransaction({
          id: transaction.id,
          expectedRevision: transaction.revision,
          patch: { memo: value },
        }),
      ).toMatchObject({ changed: false, transaction })
      expect(await other.listChangeRecords({ targetId: transaction.id })).toEqual(history)
    }
  })

  test('round trips opaque IDs and revisions at the storage seam without changing supplied history', async () => {
    const { storage, second } = await fixture()
    const id = 'vault\u0000\\0\ud800',
      revision = 'revision\udc00\\uD800'
    const vault = { id, revision, name: 'Opaque', archived: false }
    const settings = { revision, incomeAccountId: null, expenseAccountId: null }
    const record: ChangeRecord = {
      id: 'record\u0000\\0\ud800',
      vaultId: id,
      target: 'vault',
      targetId: id,
      action: 'created',
      recordedAt: '2026-11-12T00:00:00.000Z',
      before: null,
      after: vault,
      balances: [],
    }
    await storage.mutate({ kind: 'createVault' }, () => ({
      kind: 'changed',
      changes: { vault, settings },
      record,
      result: vault,
    }))
    expect((await second.read({ kind: 'vaults' })).vaults).toContainEqual(vault)
    expect(await second.read({ kind: 'vault', vaultId: id })).toMatchObject({ vault, settings })
    expect(
      (await second.read({ kind: 'history', vaultId: id, id: record.id, targetId: id })).records,
    ).toEqual([record])
    const fin = createFin({ storage: second, vaultId: id })
    const updated = await fin.updateVault({
      expectedRevision: revision,
      patch: { name: 'Updated' },
    })
    expect(await fin.getVault()).toEqual(updated.vault)
  })

  test('prepares concurrently, persists on reopen, preserves host data and rejects schema drift', async () => {
    const f = await openNeonFixture()
    cleanup.push(f.dispose)
    const checking = createNeonAdapter({
      connectionString: f.connectionString,
      autoMigrate: false,
    })
    cleanup.push(checking.close)
    await f.db.query("CREATE TABLE host_data(value text); INSERT INTO host_data VALUES ('keep')")
    await expect(listVaults({ storage: checking })).rejects.toMatchObject({
      code: 'SCHEMA_INCOMPATIBLE',
    })
    await Promise.all([checking.migrate(), f.storage.migrate()])
    const { vault } = await createVault({ storage: checking, name: 'Persistent' })
    await checking.close()
    expect(await listVaults({ storage: f.storage })).toEqual([vault])
    expect((await f.db.query('SELECT * FROM host_data')).rows).toEqual([{ value: 'keep' }])
    await f.db.query('ALTER TABLE fin_accounts DROP CONSTRAINT fin_accounts_currency_check')
    await expect(listVaults({ storage: f.storage })).rejects.toMatchObject({
      code: 'SCHEMA_INCOMPATIBLE',
    })
    expect((await f.db.query('SELECT count(*)::int AS count FROM fin_vaults')).rows).toEqual([
      { count: 1 },
    ])
  })

  test('rejects incompatible text encoding identities without rewriting existing data', async () => {
    const { db, storage, vault } = await fixture()
    await db.query(
      "UPDATE fin_migrations SET identity=replace(identity, '-- fin text encoding: backslash-v1 (NUL and lone UTF-16 surrogates).' || chr(10), '')",
    )
    await expect(listVaults({ storage })).rejects.toMatchObject({ code: 'SCHEMA_INCOMPATIBLE' })
    expect((await db.query('SELECT name FROM fin_vaults WHERE id=$1', [vault.id])).rows).toEqual([
      { name: vault.name },
    ])
  })

  test('rejects malformed stored text instead of returning a corrupted value', async () => {
    const { db, fin, vault } = await fixture()
    await db.query('UPDATE fin_vaults SET name=$2 WHERE id=$1', [vault.id, 'invalid\\escape'])
    await expect(fin.getVault()).rejects.toMatchObject({
      code: 'STORAGE_FAILURE',
      application: 'not_applied',
      message: 'Stored Neon text has an invalid encoding.',
    })
  })

  test.each(['unknown', 'partial', 'version'])(
    'rejects %s schemas without repair',
    async (kind) => {
      const f = await openNeonFixture()
      cleanup.push(f.dispose)
      if (kind === 'unknown') await f.db.query('CREATE TABLE fin_stranger(value text)')
      else {
        await f.storage.migrate()
        await f.db.query(
          kind === 'partial'
            ? 'DROP VIEW fin_category_paths'
            : 'UPDATE fin_migrations SET version=999',
        )
      }
      await expect(f.storage.migrate()).rejects.toMatchObject({ code: 'SCHEMA_INCOMPATIBLE' })
    },
  )

  test.each(['edit', 'delete', 'classify', 'adjust'])(
    'rolls back %s and exact history on late insertion failure',
    async (operation) => {
      const { db, fin, other } = await fixture()
      const { account } = await fin.createAccount({
        name: 'Cash',
        nature: 'asset',
        currency: 'KRW',
      })
      const { transaction } = await fin.recordIncomeExpense({
        kind: 'expense',
        accountId: account.id,
        amountMinor: 500,
      })
      const { category } = await fin.createCategory({ name: 'Food' })
      const before = await other.getAccount({ id: account.id })
      const records = await other.listChangeRecords()
      await db.query(
        "CREATE FUNCTION reject_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private SQL failure'; END $$; CREATE TRIGGER reject_history BEFORE INSERT ON fin_change_records FOR EACH ROW EXECUTE FUNCTION reject_history()",
      )
      const input = { id: transaction.id, expectedRevision: transaction.revision }
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
      expect(await other.getTransaction({ id: transaction.id })).toEqual(transaction)
      expect(await other.getAccount({ id: account.id })).toEqual(before)
      expect(await other.listChangeRecords()).toEqual(records)
    },
  )

  test('protects revision, name, duplicate and aggregate predicates across independent pools', async () => {
    const { fin, other } = await fixture()
    const names = await Promise.allSettled([
      fin.createAccount({ name: 'Cash', nature: 'asset', currency: 'KRW' }),
      other.createAccount({ name: 'Cash', nature: 'asset', currency: 'KRW' }),
    ])
    expect(names.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const account = (await fin.listAccounts())[0]
    if (!account) throw new Error('Missing account')
    const input = {
      kind: 'income' as const,
      accountId: account.id,
      amountMinor: 100,
      occurredOn: '2026-11-12',
      memo: 'same',
    }
    const duplicates = await Promise.allSettled([
      fin.recordIncomeExpense(input),
      other.recordIncomeExpense(input),
    ])
    expect(duplicates.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(duplicates.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { code: 'DUPLICATE_CANDIDATE' },
    })
    const transaction = (await fin.listTransactions())[0]
    if (!transaction) throw new Error('Missing transaction')
    const edits = await Promise.allSettled([
      fin.editTransaction({
        id: transaction.id,
        expectedRevision: transaction.revision,
        patch: { memo: 'A' },
      }),
      other.editTransaction({
        id: transaction.id,
        expectedRevision: transaction.revision,
        patch: { memo: 'B' },
      }),
    ])
    expect(edits.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(edits.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { code: 'CONFLICT' },
    })
    const before = await fin.getAccount({ id: account.id })
    const balances = await Promise.allSettled([
      fin.adjustAccountBalance({
        accountId: account.id,
        expectedRevision: before.balanceRevision,
        targetBalanceMinor: 400,
      }),
      other.adjustAccountBalance({
        accountId: account.id,
        expectedRevision: before.balanceRevision,
        targetBalanceMinor: 700,
      }),
    ])
    expect(balances.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(balances.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { code: 'CONFLICT' },
    })
  })

  test('protects category absence, parent archive and settings dependencies', async () => {
    const { fin, other } = await fixture()
    const siblings = await Promise.allSettled([
      fin.createCategory({ name: 'Food' }),
      other.createCategory({ name: 'Food' }),
    ])
    expect(siblings.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const parent = (await fin.listCategories())[0]
    if (!parent) throw new Error('Missing parent')
    await fin.updateCategory({
      id: parent.id,
      expectedRevision: parent.revision,
      patch: { archived: true },
    })
    await expect(
      other.createCategory({ name: 'Coffee', parentId: parent.id }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    const { account } = await fin.createAccount({ name: 'Cash', nature: 'asset', currency: 'KRW' })
    const settings = await fin.getSettings()
    const results = await Promise.allSettled([
      fin.setDefaultAccount({
        kind: 'income',
        accountId: account.id,
        expectedRevision: settings.revision,
      }),
      other.setDefaultAccount({
        kind: 'expense',
        accountId: account.id,
        expectedRevision: settings.revision,
      }),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { code: 'CONFLICT' },
    })
  })

  test('preserves supplied revisions/history, no-ops, decision failures, async/nested rejection and atomic creation', async () => {
    const { storage, second, vault, fin, db } = await fixture()
    const records = await fin.listChangeRecords()
    let calls = 0
    const pending: Promise<unknown>[] = []
    await storage.mutate({ kind: 'vault', vaultId: vault.id }, () => {
      calls++
      pending.push(
        expect(storage.read({ kind: 'vaults' })).rejects.toMatchObject({ code: 'INVALID_INPUT' }),
        expect(second.read({ kind: 'vaults' })).rejects.toMatchObject({ code: 'INVALID_INPUT' }),
        expect(storage.close()).rejects.toMatchObject({ code: 'INVALID_INPUT' }),
      )
      return { kind: 'unchanged', result: 'same' }
    })
    expect(calls).toBe(1)
    await Promise.all(pending)
    await expect(
      storage.mutate(
        { kind: 'vault', vaultId: vault.id },
        // @ts-expect-error Runtime rejection of asynchronous consumers is required.
        async () => ({ kind: 'unchanged', result: null }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(
      storage.mutate({ kind: 'vault', vaultId: vault.id }, () => {
        throw new Error('private decision')
      }),
    ).rejects.toMatchObject({ code: 'STORAGE_FAILURE' })
    expect(await fin.listChangeRecords()).toEqual(records)
    const value = { ...vault, id: 'fixed-id', revision: 'opaque-revision' }
    const record: ChangeRecord = {
      id: 'fixed-record',
      vaultId: value.id,
      target: 'vault',
      targetId: value.id,
      action: 'created',
      recordedAt: '2026-11-12T00:00:00.000Z',
      before: null,
      after: value,
      balances: [],
    }
    const decision: MutationDecision<string> = {
      kind: 'changed',
      changes: {
        vault: value,
        settings: { revision: 'settings-revision', incomeAccountId: null, expenseAccountId: null },
      },
      record,
      result: 'exact',
    }
    const collision = await Promise.allSettled([
      storage.mutate({ kind: 'createVault' }, () => decision),
      second.mutate({ kind: 'createVault' }, () => decision),
    ])
    expect(collision.filter((r) => r.status === 'fulfilled')).toEqual([
      { status: 'fulfilled', value: 'exact' },
    ])
    expect(collision.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { code: 'CONFLICT' },
    })
    expect(
      (await db.query('SELECT payload FROM fin_change_records WHERE "vaultId"=$1', [value.id]))
        .rows,
    ).toEqual([{ payload: record }])
  })

  test('drains admitted work, rejects new work and allows independent Vault progress', async () => {
    const { storage, second, db, vault } = await fixture()
    const another = (await createVault({ storage: second, name: 'Independent' })).vault
    await db.query('BEGIN')
    await db.query('SELECT id FROM fin_vaults WHERE id=$1 FOR UPDATE', [vault.id])
    let called = false
    const work = storage.mutate({ kind: 'vault', vaultId: vault.id }, () => {
      called = true
      return { kind: 'unchanged', result: 'drained' }
    })
    const close = storage.close()
    let closed = false
    void close.then(() => {
      closed = true
    })
    await expect(storage.read({ kind: 'vaults' })).rejects.toMatchObject({
      code: 'STORAGE_FAILURE',
    })
    await second.mutate({ kind: 'vault', vaultId: another.id }, () => ({
      kind: 'unchanged',
      result: null,
    }))
    expect(called).toBe(false)
    expect(closed).toBe(false)
    await db.query('ROLLBACK')
    expect(await work).toBe('drained')
    await close
  })

  test('existing tools preserve financial reads, mutations and errors', async () => {
    const { storage, fin, vault } = await fixture()
    const tools = createFinTools({
      access: {
        listVaults: (options) => listVaults({ storage, ...options }),
        createVault: (input) => createVault({ storage, ...input }),
        getFin: async () => fin,
      },
    })
    const { account } = await tools['accounts.create'].execute({
      vaultId: vault.id,
      name: 'Tool account',
      nature: 'asset',
      currency: 'KRW',
    })
    expect((await tools['balances.query'].execute({ vaultId: vault.id })).accounts[0]?.id).toBe(
      account.id,
    )
    await expect(
      tools['accounts.create'].execute({
        vaultId: vault.id,
        name: 'Tool account',
        nature: 'asset',
        currency: 'KRW',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  test(
    'times out a real successful COMMIT with its acknowledgement stalled, discards the session and never replays',
    { timeout: 60000 },
    async () => {
      const { targetConnectionString, fin, vault } = await fixture()
      let armed = false,
        decisions = 0,
        submitted = 0,
        committed = 0
      const proxy = await openNeonProxy(targetConnectionString, {
        beforeQuery(sql) {
          if (armed && sql === 'COMMIT') submitted++
        },
        afterCommand(command) {
          if (armed && command === 'COMMIT') {
            committed++
            return 'stall'
          }
        },
      })
      cleanup.push(proxy.dispose)
      const storage = createNeonAdapter({ connectionString: proxy.connectionString })
      cleanup.push(storage.close)
      const before = await fin.listChangeRecords()
      const updated = {
        ...vault,
        name: 'Committed despite real timeout',
        revision: 'timeout-revision',
      }
      const record: ChangeRecord = {
        id: 'timeout-record',
        vaultId: vault.id,
        target: 'vault',
        targetId: vault.id,
        action: 'updated',
        recordedAt: new Date().toISOString(),
        before: vault,
        after: updated,
        balances: [],
      }
      const started = Date.now()
      await expect(
        storage.mutate({ kind: 'vault', vaultId: vault.id }, () => {
          decisions++
          armed = true
          return { kind: 'changed', changes: { vault: updated }, record, result: null }
        }),
      ).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN', application: 'unknown' })
      expect(Date.now() - started).toBeGreaterThanOrEqual(29000)
      expect({ decisions, submitted, committed }).toEqual({
        decisions: 1,
        submitted: 1,
        committed: 1,
      })
      expect(await fin.getVault()).toEqual(updated)
      expect(await fin.listChangeRecords()).toEqual([...before, record])
      armed = false
      const discarded = proxy.sessions
      expect((await storage.read({ kind: 'vault', vaultId: vault.id })).vault).toEqual(updated)
      expect(proxy.sessions).toBeGreaterThan(discarded)
      await storage.close()
      expect(proxy.openClients).toBe(0)
    },
  )

  test.each(['disconnect', 'malformed'] as const)(
    'loses a real successful COMMIT reply (%s), never replays, and independently inspects persisted state',
    async (fault) => {
      const { targetConnectionString, fin, vault, db } = await fixture()
      let armed = false,
        commits = 0,
        successfulCommits = 0
      const proxy = await openNeonProxy(targetConnectionString, {
        beforeQuery(sql) {
          if (armed && sql === 'COMMIT') commits++
        },
        afterCommand(command) {
          if (armed && command === 'COMMIT') {
            successfulCommits++
            return fault
          }
        },
      })
      cleanup.push(proxy.dispose)
      const storage = createNeonAdapter({ connectionString: proxy.connectionString })
      cleanup.push(storage.close)
      const before = await fin.listChangeRecords()
      let decisions = 0
      const updated = { ...vault, name: 'Committed despite disconnect', revision: 'wire-revision' }
      const record: ChangeRecord = {
        id: 'wire-record',
        vaultId: vault.id,
        target: 'vault',
        targetId: vault.id,
        action: 'updated',
        recordedAt: new Date().toISOString(),
        before: vault,
        after: updated,
        balances: [],
      }
      await expect(
        storage.mutate({ kind: 'vault', vaultId: vault.id }, () => {
          decisions++
          armed = true
          return { kind: 'changed', changes: { vault: updated }, record, result: null }
        }),
      ).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN', application: 'unknown' })
      expect({ decisions, commits, successfulCommits }).toEqual({
        decisions: 1,
        commits: 1,
        successfulCommits: 1,
      })
      armed = false
      const brokenSession = proxy.sessions
      expect((await storage.read({ kind: 'vault', vaultId: vault.id })).vault).toEqual(updated)
      expect(proxy.sessions).toBeGreaterThan(brokenSession)
      expect(await fin.getVault()).toEqual(updated)
      expect(await fin.listChangeRecords()).toEqual([...before, record])
      expect(
        (await db.query('SELECT name,revision FROM fin_vaults WHERE id=$1', [vault.id])).rows,
      ).toEqual([{ name: updated.name, revision: updated.revision }])
    },
  )
})
