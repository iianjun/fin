import { afterEach, describe, expect, test, vi } from 'vitest'
import { createFin, createVault, listVaults } from '@fin-kit/core'
import { createPostgresAdapter } from '@fin-kit/postgres'
import { createFinTools } from '@fin-kit/tools'
import type { ChangeRecord, MutationDecision } from '@fin-kit/provider'
import { openPostgresFixture } from '../test/fixture.js'
import { openPostgresProxy } from '../test/proxy.js'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

test('validates options synchronously and creates/closes without network I/O', async () => {
  expect(() => createPostgresAdapter({ connectionString: ' ' })).toThrowError(
    expect.objectContaining({ code: 'INVALID_INPUT' }),
  )
  expect(() => createPostgresAdapter({ connectionString: 'https://example.com' })).toThrowError(
    expect.objectContaining({ code: 'INVALID_INPUT' }),
  )
  const storage = createPostgresAdapter({
    connectionString: 'postgres://user:private@127.0.0.1:1/missing',
  })
  const first = storage.close()
  expect(storage.close()).toBe(first)
  await first
  await expect(storage.read({ kind: 'vaults' })).rejects.toMatchObject({ code: 'STORAGE_FAILURE' })
})

describe.skipIf(!process.env.FIN_POSTGRES_URL)('real PostgreSQL contract', () => {
  async function fixture() {
    const f = await openPostgresFixture()
    cleanup.push(f.dispose)
    const { vault } = await createVault({ storage: f.storage, name: 'Household' })
    const fin = createFin({ storage: f.storage, vaultId: vault.id })
    const second = createPostgresAdapter({ connectionString: f.connectionString })
    cleanup.push(second.close)
    return { ...f, vault, fin, second, other: createFin({ storage: second, vaultId: vault.id }) }
  }

  test('reads one repeatable snapshot across concurrent multi-table changes', async () => {
    const { connectionString, fin, vault } = await fixture()
    const { account } = await fin.createAccount({ name: 'Cash', nature: 'asset', currency: 'KRW' })
    let resume = () => {},
      reached = () => {}
    const gate = new Promise<void>((resolve) => {
      resume = resolve
    })
    const paused = new Promise<void>((resolve) => {
      reached = resolve
    })
    const proxy = await openPostgresProxy(connectionString, {
      beforeQuery: async (sql) => {
        if (sql.startsWith('SELECT revision,"incomeAccountId"')) {
          reached()
          await gate
        }
      },
    })
    cleanup.push(proxy.dispose)
    const storage = createPostgresAdapter({ connectionString: proxy.connectionString })
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
    const f = await openPostgresFixture()
    cleanup.push(f.dispose)
    await f.db.query("CREATE TABLE host_data(value text); INSERT INTO host_data VALUES ('keep')")
    let failed = false
    const proxy = await openPostgresProxy(f.connectionString, {
      afterCommand(command) {
        if (!failed && command === 'CREATE TABLE') {
          failed = true
          return 'disconnect'
        }
      },
    })
    cleanup.push(proxy.dispose)
    const storage = createPostgresAdapter({ connectionString: proxy.connectionString })
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
    const { connectionString, fin, other, vault, db } = await fixture()
    const { category } = await fin.createCategory({ name: 'Parent' })
    let resume = () => {},
      reached = () => {}
    const gate = new Promise<void>((resolve) => {
      resume = resolve
    })
    const paused = new Promise<void>((resolve) => {
      reached = resolve
    })
    const proxy = await openPostgresProxy(connectionString, {
      beforeQuery: async (sql) => {
        if (sql.startsWith('SELECT id,name,revision,archived FROM fin_vaults WHERE id=')) {
          reached()
          await gate
        }
      },
    })
    cleanup.push(proxy.dispose)
    const storage = createPostgresAdapter({ connectionString: proxy.connectionString })
    cleanup.push(storage.close)
    const writer = createFin({ storage, vaultId: vault.id })
    const archive = writer.updateCategory({
      id: category.id,
      expectedRevision: category.revision,
      patch: { archived: true },
    })
    await paused
    const child = other.createCategory({ name: 'Child', parentId: category.id })
    const rejected = expect(child).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    try {
      await expect
        .poll(
          async () =>
            (
              await db.query(
                "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FOR UPDATE%'",
              )
            ).rows[0]?.n,
        )
        .toBeGreaterThan(0)
    } finally {
      resume()
    }
    await archive
    await rejected
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
    const f = await openPostgresFixture()
    cleanup.push(f.dispose)
    const checking = createPostgresAdapter({
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
      message: 'Stored PostgreSQL text has an invalid encoding.',
    })
  })

  test.each(['unknown', 'partial', 'version'])(
    'rejects %s schemas without repair',
    async (kind) => {
      const f = await openPostgresFixture()
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

  test('loses a real successful COMMIT reply at the wire, never replays, and independently inspects persisted state', async () => {
    const { connectionString, fin, vault, db } = await fixture()
    let armed = false,
      commits = 0,
      successfulCommits = 0
    const proxy = await openPostgresProxy(connectionString, {
      beforeQuery(sql) {
        if (armed && sql === 'COMMIT') commits++
      },
      afterCommand(command) {
        if (armed && command === 'COMMIT') {
          successfulCommits++
          return 'disconnect'
        }
      },
    })
    cleanup.push(proxy.dispose)
    const storage = createPostgresAdapter({ connectionString: proxy.connectionString })
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
    expect(await fin.getVault()).toEqual(updated)
    expect(await fin.listChangeRecords()).toEqual([...before, record])
    expect(
      (await db.query('SELECT name,revision FROM fin_vaults WHERE id=$1', [vault.id])).rows,
    ).toEqual([{ name: updated.name, revision: updated.revision }])
  })
})
