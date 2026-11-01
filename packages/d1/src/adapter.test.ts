import { afterEach, expect, test } from 'vitest'
import { createFin, createVault, listVaults, FinError } from '@fin/core'
import { createD1Adapter } from '@fin/d1'
import { openD1Fixture } from '../test/fixture.js'

const disposers: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
})

test('constructs from connection options without I/O and prepares local D1 on first use', async () => {
  const fixture = await openD1Fixture()
  disposers.push(fixture.dispose)
  expect(fixture.transport).not.toHaveBeenCalled()
  expect(await listVaults({ storage: fixture.storage })).toEqual([])
  const { vault } = await createVault({ storage: fixture.storage, name: 'D1 ledger' })
  const fin = createFin({ storage: fixture.storage, vaultId: vault.id })
  expect((await fin.getVault()).name).toBe('D1 ledger')
  const first = fixture.transport.mock.calls[0]
  expect(first?.[0]).toBe(
    'https://api.cloudflare.com/client/v4/accounts/test-account/d1/database/test-database/raw',
  )
  expect(new Headers(first?.[1]?.headers).get('Authorization')).toBe('Bearer test-token')
})

test('rejects empty connection options without opening a network connection', () => {
  expect(() => createD1Adapter({ accountId: '', databaseId: 'db', apiToken: 'secret' })).toThrow(
    FinError,
  )
})

test('supports explicit preparation and detached methods without sharing schema state between adapters', async () => {
  const fixture = await openD1Fixture()
  disposers.push(fixture.dispose)
  const storage = createD1Adapter({ ...fixture.options, autoMigrate: false })
  await expect(listVaults({ storage })).rejects.toMatchObject({ code: 'SCHEMA_INCOMPATIBLE' })
  const { migrate, read } = storage
  await migrate()
  expect((await read({ kind: 'vaults' })).vaults).toEqual([])
  await migrate()
})

test('prepares concurrent first users atomically and preserves unrelated host tables', async () => {
  const fixture = await openD1Fixture()
  disposers.push(fixture.dispose)
  await fixture.database.exec(
    "CREATE TABLE host_data (value TEXT); INSERT INTO host_data VALUES ('retained')",
  )
  const second = createD1Adapter(fixture.options)
  await Promise.all([
    createVault({ storage: fixture.storage, name: 'First' }),
    createVault({ storage: second, name: 'Second' }),
  ])
  expect(await listVaults({ storage: fixture.storage })).toHaveLength(2)
  expect((await fixture.database.prepare('SELECT value FROM host_data').all()).results).toEqual([
    { value: 'retained' },
  ])
  expect(
    (await fixture.database.prepare('SELECT version FROM fin_migrations').all()).results,
  ).toEqual([{ version: 1 }])
})

test('rejects an incomplete namespace without repairing or deleting existing data', async () => {
  const fixture = await openD1Fixture()
  disposers.push(fixture.dispose)
  await fixture.database.exec(
    "CREATE TABLE fin_incomplete (value TEXT); INSERT INTO fin_incomplete VALUES ('retained')",
  )
  await expect(createVault({ storage: fixture.storage, name: 'Rejected' })).rejects.toMatchObject({
    code: 'SCHEMA_INCOMPATIBLE',
    application: 'not_applied',
  })
  expect(
    (await fixture.database.prepare('SELECT value FROM fin_incomplete').all()).results,
  ).toEqual([{ value: 'retained' }])
})

test('rolls back initial DDL and its migration ledger when a later statement fails', async () => {
  const fixture = await openD1Fixture()
  disposers.push(fixture.dispose)
  const storage = createD1Adapter({
    ...fixture.options,
    fetch: (input, init) =>
      fixture.options.fetch(input, {
        ...init,
        body: String(init?.body).replace('CREATE TABLE fin_settings', 'INVALID_SQL fin_settings'),
      }),
  })
  await expect(storage.migrate()).rejects.toMatchObject({
    code: 'STORAGE_FAILURE',
    application: 'not_applied',
  })
  expect(
    (await fixture.database.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'fin_%'").all())
      .results,
  ).toEqual([])
})

test('demonstrates that a zero-row conditional write does not abort a D1 batch', async () => {
  const fixture = await openD1Fixture()
  disposers.push(fixture.dispose)
  await fixture.storage.migrate()
  await fixture.database.exec('CREATE TABLE host_marker (value TEXT)')
  await fixture.database.batch([
    fixture.database.prepare("UPDATE fin_vaults SET stamp=stamp+1 WHERE id='missing'"),
    fixture.database.prepare("INSERT INTO host_marker VALUES ('applied')"),
  ])
  expect((await fixture.database.prepare('SELECT value FROM host_marker').all()).results).toEqual([
    { value: 'applied' },
  ])
})

test('rejects asynchronous decisions before financial writes', async () => {
  const fixture = await openD1Fixture()
  disposers.push(fixture.dispose)
  const { vault } = await createVault({ storage: fixture.storage, name: 'Pure decisions' })
  const fin = createFin({ storage: fixture.storage, vaultId: vault.id })
  const before = await fin.listChangeRecords()
  // @ts-expect-error Deliberately violate the public synchronous decision contract.
  const operation = fixture.storage.mutate({ kind: 'vault', vaultId: vault.id }, async () => ({
    kind: 'unchanged',
    result: null,
  }))
  await expect(operation).rejects.toMatchObject({
    code: 'INVALID_INPUT',
    application: 'not_applied',
  })
  expect(await fin.listChangeRecords()).toEqual(before)
})

test.each(['edit', 'delete', 'classifications', 'adjust'])(
  'rolls back %s data, revisions, stamp and history when history insertion fails',
  async (operation) => {
    const fixture = await openD1Fixture()
    disposers.push(fixture.dispose)
    const { storage, database } = fixture
    const { vault } = await createVault({ storage, name: 'Rollback' })
    const fin = createFin({ storage, vaultId: vault.id })
    const account = (await fin.createAccount({ name: 'Cash', nature: 'asset', currency: 'KRW' }))
      .account
    const transaction = (
      await fin.recordIncomeExpense({ kind: 'income', accountId: account.id, amountMinor: 100 })
    ).transaction
    const category = (await fin.createCategory({ name: 'Salary' })).category
    const before = {
      transaction: await fin.getTransaction({ id: transaction.id }),
      account: await fin.getAccount({ id: account.id }),
      history: await fin.listChangeRecords(),
      stamp: (await database.prepare('SELECT generation,stamp FROM fin_vaults').all()).results,
    }
    await database.exec(
      "CREATE TRIGGER reject_history BEFORE INSERT ON fin_change_records BEGIN SELECT RAISE(ABORT,'forced history failure'); END",
    )
    const change =
      operation === 'edit'
        ? fin.editTransaction({
            id: transaction.id,
            expectedRevision: transaction.revision,
            patch: { memo: 'changed' },
          })
        : operation === 'delete'
          ? fin.deleteTransaction({ id: transaction.id, expectedRevision: transaction.revision })
          : operation === 'classifications'
            ? fin.setCategoryAssignments({
                id: transaction.id,
                expectedRevision: transaction.revision,
                assignments: [{ categoryId: category.id, amountMinor: 100, origin: 'explicit' }],
              })
            : fin.adjustAccountBalance({
                accountId: account.id,
                expectedRevision: before.account.balanceRevision,
                targetBalanceMinor: 200,
              })
    await expect(change).rejects.toMatchObject({
      code: 'STORAGE_FAILURE',
      application: 'not_applied',
    })
    expect(await fin.getTransaction({ id: transaction.id })).toEqual(before.transaction)
    expect(await fin.getAccount({ id: account.id })).toEqual(before.account)
    expect(await fin.listChangeRecords()).toEqual(before.history)
    expect(
      (await database.prepare('SELECT generation,stamp FROM fin_vaults').all()).results,
    ).toEqual(before.stamp)
    expect((await database.prepare('SELECT * FROM fin_commit_guards').all()).results).toEqual([])
  },
)

test('allows only one of two commits from the same snapshot without rerunning decisions', async () => {
  const fixture = await openD1Fixture()
  disposers.push(fixture.dispose)
  const { vault } = await createVault({ storage: fixture.storage, name: 'Race' })
  const fin = createFin({ storage: fixture.storage, vaultId: vault.id })
  const account = (await fin.createAccount({ name: 'Cash', nature: 'asset', currency: 'KRW' }))
    .account
  const transaction = (
    await fin.recordIncomeExpense({ kind: 'income', accountId: account.id, amountMinor: 100 })
  ).transaction
  const history = await fin.listChangeRecords()
  let arrivals = 0
  let release: (() => void) | undefined
  const barrier = new Promise<void>((resolve) => {
    release = resolve
  })
  const transport: typeof fetch = async (input, init) => {
    if (String(init?.body).includes('INSERT INTO fin_commit_guards')) {
      arrivals++
      if (arrivals === 2) release?.()
      await barrier
    }
    return fixture.options.fetch(input, init)
  }
  const first = createD1Adapter({ ...fixture.options, fetch: transport })
  const second = createD1Adapter({ ...fixture.options, fetch: transport })
  await Promise.all([first.migrate(), second.migrate()])
  const writers = [first, second].map((storage) => createFin({ storage, vaultId: vault.id }))
  const results = await Promise.allSettled(
    writers.map((writer, index) =>
      writer.editTransaction({
        id: transaction.id,
        expectedRevision: transaction.revision,
        patch: { amountMinor: 110 + index },
      }),
    ),
  )
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
  const rejected = results.find((result) => result.status === 'rejected')
  expect(rejected?.status === 'rejected' ? rejected.reason : null).toMatchObject({
    code: 'CONFLICT',
    application: 'not_applied',
  })
  expect(arrivals).toBe(2)
  expect(await fin.listChangeRecords()).toHaveLength(history.length + 1)
  expect((await fixture.database.prepare('SELECT * FROM fin_commit_guards').all()).results).toEqual(
    [],
  )
})

test('reports an unknown outcome after an actual commit loses its response without resending', async () => {
  const fixture = await openD1Fixture()
  disposers.push(fixture.dispose)
  const { vault } = await createVault({ storage: fixture.storage, name: 'Lost response' })
  const fin = createFin({ storage: fixture.storage, vaultId: vault.id })
  const history = await fin.listChangeRecords()
  let submitted = 0
  const storage = createD1Adapter({
    ...fixture.options,
    fetch: async (input, init) => {
      const response = await fixture.options.fetch(input, init)
      if (String(init?.body).includes('INSERT INTO fin_commit_guards')) {
        submitted++
        throw new Error('injected response loss after real local commit')
      }
      return response
    },
  })
  await expect(
    createFin({ storage, vaultId: vault.id }).createAccount({
      name: 'Applied once',
      nature: 'asset',
      currency: 'KRW',
    }),
  ).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN', application: 'unknown' })
  expect(submitted).toBe(1)
  expect(await fin.listAccounts()).toHaveLength(1)
  expect(await fin.listChangeRecords()).toHaveLength(history.length + 1)
})

test('does not expose HTTP failure details or retry a submitted write', async () => {
  const fixture = await openD1Fixture()
  disposers.push(fixture.dispose)
  const { vault } = await createVault({ storage: fixture.storage, name: 'Unavailable' })
  let submitted = 0
  const storage = createD1Adapter({
    ...fixture.options,
    fetch: async (input, init) => {
      if (String(init?.body).includes('INSERT INTO fin_commit_guards')) {
        submitted++
        return Response.json(
          { success: false, errors: [{ message: 'secret SQL and token detail' }] },
          { status: 503 },
        )
      }
      return fixture.options.fetch(input, init)
    },
  })
  const failure = await createFin({ storage, vaultId: vault.id })
    .createAccount({ name: 'Cash', nature: 'asset', currency: 'KRW' })
    .then(
      () => null,
      (error: unknown) => error,
    )
  expect(failure).toBeInstanceOf(FinError)
  expect(failure).toMatchObject({ code: 'OUTCOME_UNKNOWN', application: 'unknown' })
  expect(String(failure)).not.toContain('secret SQL and token detail')
  expect(submitted).toBe(1)
  expect(await createFin({ storage: fixture.storage, vaultId: vault.id }).listAccounts()).toEqual(
    [],
  )
})

test('rejects a mixed context instead of returning a no-op from inconsistent reads', async () => {
  const fixture = await openD1Fixture()
  disposers.push(fixture.dispose)
  const { vault } = await createVault({ storage: fixture.storage, name: 'Snapshot' })
  const fin = createFin({ storage: fixture.storage, vaultId: vault.id })
  const account = (await fin.createAccount({ name: 'Cash', nature: 'asset', currency: 'KRW' }))
    .account
  let intervened = false
  const storage = createD1Adapter({
    ...fixture.options,
    fetch: async (input, init) => {
      const response = await fixture.options.fetch(input, init)
      if (!intervened && String(init?.body).includes('from \\"fin_settings\\"')) {
        intervened = true
        await fin.createAccount({ name: 'Concurrent', nature: 'asset', currency: 'KRW' })
      }
      return response
    },
  })
  await expect(
    createFin({ storage, vaultId: vault.id }).updateAccount({
      id: account.id,
      expectedRevision: account.revision,
      patch: { name: 'Cash' },
    }),
  ).rejects.toMatchObject({ code: 'CONFLICT', application: 'not_applied' })
  expect(intervened).toBe(true)
})
