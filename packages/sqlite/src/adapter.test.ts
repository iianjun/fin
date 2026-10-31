import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { afterEach, expect, test, vi } from 'vitest'
import { createFin, createVault, listVaults } from '@fin/core'
import { createSqliteAdapter } from '@fin/sqlite'

const connections: Database.Database[] = []
const directories: string[] = []
const storages: ReturnType<typeof createSqliteAdapter>[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const storage of storages.splice(0)) await storage.close()
  for (const db of connections.splice(0)) db.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'fin-contract-'))
  directories.push(directory)
  const filename = join(directory, 'ledger.sqlite')
  const db = new Database(filename)
  connections.push(db)
  const storage = createSqliteAdapter({ filename })
  storages.push(storage)
  const { vault } = await createVault({ storage, name: 'Household' })
  return { db, storage, vault, fin: createFin({ storage, vaultId: vault.id }) }
}

test('serializes competing writers across native connections and rejects stale revisions', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fin-contract-'))
  directories.push(directory)
  const path = join(directory, 'ledger.sqlite')
  const storage = createSqliteAdapter({ filename: path })
  storages.push(storage)
  const { vault } = await createVault({ storage, name: 'Concurrent' })
  const fin = createFin({ storage, vaultId: vault.id })
  const account = (await fin.createAccount({ name: 'Cash', nature: 'asset', currency: 'KRW' }))
    .account
  const { transaction } = await fin.recordIncomeExpense({
    kind: 'expense',
    accountId: account.id,
    amountMinor: 100,
  })
  const workers = ['A', 'B'].map(
    (memo) =>
      new Worker(
        `
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { createFin } = await import(workerData.core);
      const { createSqliteAdapter } = await import(workerData.adapter);
      const storage = createSqliteAdapter({ filename: workerData.path });
      const fin = createFin({ storage, vaultId: workerData.vaultId });
      parentPort.once('message', async () => {
        try {
          await fin.editTransaction({ id: workerData.id, expectedRevision: workerData.revision, patch: { memo: workerData.memo } });
          parentPort.postMessage('success');
        } catch (error) { parentPort.postMessage(error.code); }
        finally { await storage.close(); parentPort.close(); }
      });
      parentPort.postMessage('ready');
    })().catch(error => { throw error; });
  `,
        {
          eval: true,
          workerData: {
            path,
            memo,
            id: transaction.id,
            revision: transaction.revision,
            vaultId: vault.id,
            core: import.meta.resolve('@fin/core'),
            adapter: import.meta.resolve('@fin/sqlite'),
          },
        },
      ),
  )
  try {
    await Promise.all(
      workers.map(
        (worker) =>
          new Promise<void>((resolve, reject) => {
            worker.once('error', reject)
            worker.once('message', () => resolve())
          }),
      ),
    )
    const results = workers.map(
      (worker) =>
        new Promise<string>((resolve, reject) => {
          worker.once('error', reject)
          worker.once('message', resolve)
        }),
    )
    for (const worker of workers) worker.postMessage('go')
    expect((await Promise.all(results)).sort()).toEqual(['CONFLICT', 'success'])
    expect(await fin.listChangeRecords({ targetId: transaction.id })).toHaveLength(2)
    expect((await fin.getAccount({ id: account.id })).balanceMinor).toBe(-100)
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()))
  }
})

test('creates an empty vault and reads it using the returned ID', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fin-contract-'))
  directories.push(directory)
  const filename = join(directory, 'ledger.sqlite')
  const db = new Database(filename)
  connections.push(db)
  const storage = createSqliteAdapter({ filename })
  storages.push(storage)
  expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'fin_%'").all()).toEqual([])
  const vault = (await createVault({ storage, name: 'Household' })).vault
  expect(await listVaults({ storage })).toEqual([vault])
  const fin = createFin({ storage, vaultId: vault.id })
  expect(await fin.listAccounts()).toEqual([])
  expect(await fin.listCategories()).toEqual([])
  expect(await fin.getSettings()).toMatchObject({ incomeAccountId: null, expenseAccountId: null })
  expect(await fin.listChangeRecords()).toHaveLength(1)
})

test.each(['edit', 'delete', 'classify', 'adjust'] as const)(
  'rolls back %s, classifications and revisions when history insertion fails',
  async (operation) => {
    const { db, fin } = await fixture()
    const account = (await fin.createAccount({ name: 'Cash', nature: 'asset', currency: 'KRW' }))
      .account
    const created = await fin.recordIncomeExpense({
      kind: 'expense',
      accountId: account.id,
      amountMinor: 500,
    })
    const category = (await fin.createCategory({ name: 'Food' })).category
    const before = await fin.getAccount({ id: account.id })
    const records = await fin.listChangeRecords()
    db.exec(
      "CREATE TRIGGER reject_history BEFORE INSERT ON fin_change_records BEGIN SELECT RAISE(ABORT, 'private SQL failure'); END",
    )
    const input = { id: created.transaction.id, expectedRevision: created.transaction.revision }
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
    expect(await fin.getTransaction({ id: created.transaction.id })).toEqual(created.transaction)
    expect(await fin.getAccount({ id: account.id })).toEqual(before)
    expect(await fin.listChangeRecords()).toEqual(records)
    db.exec('DROP TRIGGER reject_history')
    expect(
      (
        await fin.editTransaction({
          id: created.transaction.id,
          expectedRevision: created.transaction.revision,
          patch: { amountMinor: 1000 },
        })
      ).changed,
    ).toBe(true)
  },
)

test('supports explicit migration and rejects incompatible or incomplete schemas before writing', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fin-contract-'))
  directories.push(directory)
  const filename = join(directory, 'ledger.sqlite')
  const db = new Database(filename)
  connections.push(db)
  db.exec("CREATE TABLE host_data (value TEXT); INSERT INTO host_data VALUES ('keep')")
  const storage = createSqliteAdapter({ filename, autoMigrate: false })
  storages.push(storage)
  await expect(createVault({ storage, name: 'Not ready' })).rejects.toMatchObject({
    code: 'SCHEMA_INCOMPATIBLE',
    application: 'not_applied',
  })
  await storage.migrate()
  const vault = (await createVault({ storage, name: 'Ready' })).vault
  expect((await listVaults({ storage }))[0]?.id).toBe(vault.id)
  expect(db.prepare('SELECT value FROM host_data').get()).toEqual({ value: 'keep' })
  db.exec('UPDATE fin_migrations SET version=999')
  await expect(createVault({ storage, name: 'Blocked' })).rejects.toMatchObject({
    code: 'SCHEMA_INCOMPATIBLE',
  })
  db.exec('UPDATE fin_migrations SET version=1; DROP TABLE fin_transaction_relations')
  await expect(listVaults({ storage })).rejects.toMatchObject({ code: 'SCHEMA_INCOMPATIBLE' })
})

test('rejects asynchronous mutation decisions before any financial write', async () => {
  const { storage, vault, fin } = await fixture()
  const before = await fin.listChangeRecords()
  await expect(
    storage.mutate(
      { kind: 'vault', vaultId: vault.id },
      // @ts-expect-error Mutation decisions must be synchronous.
      async () => ({ kind: 'unchanged', result: null }),
    ),
  ).rejects.toMatchObject({ code: 'INVALID_INPUT', application: 'not_applied' })
  expect(await fin.listChangeRecords()).toEqual(before)
})

test('rolls back a partially executed initial migration and preserves host data', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fin-contract-'))
  directories.push(directory)
  const filename = join(directory, 'ledger.sqlite')
  const db = new Database(filename)
  connections.push(db)
  db.exec("CREATE TABLE host_data(value TEXT); INSERT INTO host_data VALUES ('keep')")
  const storage = createSqliteAdapter({ filename })
  storages.push(storage)
  const exec = Database.prototype.exec
  const failure = vi.spyOn(Database.prototype, 'exec').mockImplementationOnce(function (
    this: Database.Database,
    sql: string,
  ) {
    exec.call(this, sql)
    throw new Error('Injected failure after schema DDL and before the migration ledger')
  })
  await expect(storage.migrate()).rejects.toMatchObject({
    code: 'STORAGE_FAILURE',
    application: 'not_applied',
  })
  expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'fin_%'").all()).toEqual([])
  expect(db.prepare('SELECT value FROM host_data').get()).toEqual({ value: 'keep' })
  failure.mockRestore()
  await storage.migrate()
  expect((await createVault({ storage, name: 'Ready' })).changed).toBe(true)
})

test('owns a file connection, closes idempotently, and reopens persisted vaults', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fin-lifecycle-'))
  directories.push(directory)
  const filename = join(directory, 'ledger.sqlite')
  const storage = createSqliteAdapter({ filename })
  storages.push(storage)
  const { vault } = await createVault({ storage, name: 'Persistent' })
  await storage.close()
  await storage.close()
  await expect(listVaults({ storage })).rejects.toMatchObject({
    code: 'STORAGE_FAILURE',
    application: 'not_applied',
  })
  await expect(createVault({ storage, name: 'Closed' })).rejects.toMatchObject({
    code: 'STORAGE_FAILURE',
    application: 'not_applied',
  })
  await expect(storage.migrate()).rejects.toMatchObject({ code: 'STORAGE_FAILURE' })
  const reopened = createSqliteAdapter({ filename })
  storages.push(reopened)
  expect(await listVaults({ storage: reopened })).toEqual([vault])
})

test('rejects closing during a mutation decision without breaking the connection', async () => {
  const { storage, vault } = await fixture()
  const closes: Promise<void>[] = []
  await storage.mutate({ kind: 'vault', vaultId: vault.id }, () => {
    closes.push(storage.close())
    return { kind: 'unchanged', result: null }
  })
  await expect(closes[0]).rejects.toMatchObject({
    code: 'INVALID_INPUT',
    application: 'not_applied',
  })
  expect(await listVaults({ storage })).toEqual([vault])
})

test('rejects an empty filename before opening a database', () => {
  expect(() => createSqliteAdapter({ filename: ' ' })).toThrowError(
    expect.objectContaining({ code: 'INVALID_INPUT', application: 'not_applied' }),
  )
})

test('maps connection creation failures to a public storage error', () => {
  const directory = mkdtempSync(join(tmpdir(), 'fin-open-failure-'))
  directories.push(directory)
  expect(() =>
    createSqliteAdapter({ filename: join(directory, 'missing', 'ledger.sqlite') }),
  ).toThrowError(expect.objectContaining({ code: 'STORAGE_FAILURE', application: 'not_applied' }))
})
