import { afterEach, describe, expect, test, vi } from 'vitest'
import { createFin, createVault, listVaults, FinError } from '@fin/core'
import { createSqliteAdapter } from '@fin/sqlite'
import { tursoContractTarget } from '../../turso/test/hosted-fixture.js'
import { openD1Fixture } from '../../d1/test/fixture.js'
import { createFinTools, type FinVaultAccess } from './index.js'

describe.each([
  {
    name: 'SQLite',
    async open() {
      const storage = createSqliteAdapter({ filename: ':memory:' })
      return { storage, dispose: storage.close }
    },
  },
  tursoContractTarget,
  { name: 'local D1 REST', open: openD1Fixture },
])('$name public tools', ({ open }) => {
  const disposers: (() => void | Promise<void>)[] = []
  afterEach(async () => {
    for (const dispose of disposers.splice(0)) await dispose()
  })

  async function fixture() {
    const { storage, dispose } = await open()
    disposers.push(dispose)
    const allowed = new Set<string>()
    const access: FinVaultAccess = {
      async listVaults(options) {
        return (await listVaults({ storage, ...options })).filter((vault) => allowed.has(vault.id))
      },
      async createVault(input) {
        const result = await createVault({ storage, ...input })
        allowed.add(result.vault.id)
        return result
      },
      async getFin(vaultId) {
        if (!allowed.has(vaultId))
          throw new FinError(
            'FORBIDDEN',
            'Vault access denied.',
            'Choose an authorized Vault.',
            'not_applied',
            { vaultId },
          )
        return createFin({ storage, vaultId, timeZone: 'Asia/Seoul' })
      },
    }
    return { storage, allowed, access, tools: createFinTools({ access }) }
  }

  test('empty authorized catalog, creation, name collisions, rename, archive and reactivation', async () => {
    const { tools } = await fixture()
    expect(await tools['vaults.list'].execute({})).toEqual([])
    const { vault } = await tools['vaults.create'].execute({ name: 'Home' })
    const vaultId = vault.id
    await expect(
      tools['vaults.archive'].execute({ vaultId, expectedRevision: ` ${vault.revision} ` }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    const { account } = await tools['accounts.create'].execute({
      vaultId,
      name: 'Cash',
      nature: 'asset',
      currency: 'KRW',
    })
    const result = await tools['transactions.recordIncomeExpense'].execute({
      vaultId,
      kind: 'income',
      accountId: account.id,
      amountMinor: 1000,
      occurredOn: '2026-11-08',
    })
    expect(result.transaction).toMatchObject({ kind: 'income', amountMinor: 1000 })
    await tools['vaults.create'].execute({ name: 'Home' })
    expect(await tools['vaults.resolve'].execute({ name: 'Home' })).toHaveLength(2)
    const renamed = await tools['vaults.rename'].execute({
      vaultId,
      name: 'Household',
      expectedRevision: vault.revision,
    })
    expect(renamed.vault.id).toBe(vaultId)
    const archived = await tools['vaults.archive'].execute({
      vaultId,
      expectedRevision: renamed.vault.revision,
    })
    expect(await tools['vaults.list'].execute({})).toHaveLength(1)
    expect(await tools['vaults.list'].execute({ includeArchived: true })).toHaveLength(2)
    expect(await tools['transactions.get'].execute({ vaultId, id: result.transaction.id })).toEqual(
      result.transaction,
    )
    await expect(
      tools['accounts.create'].execute({
        vaultId,
        name: 'Blocked',
        nature: 'asset',
        currency: 'KRW',
      }),
    ).rejects.toMatchObject({ code: 'VAULT_ARCHIVED', application: 'not_applied' })
    const active = await tools['vaults.reactivate'].execute({
      vaultId,
      expectedRevision: archived.vault.revision,
    })
    expect(active.vault.archived).toBe(false)
    await expect(
      tools['vaults.rename'].execute({ vaultId, name: 'Wrong', expectedRevision: vault.revision }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  test('preserves results, revisions, no-ops, deletion and exact history', async () => {
    const { tools, access } = await fixture()
    const { vault } = await tools['vaults.create'].execute({ name: 'Home' })
    const vaultId = vault.id
    const { account } = await tools['accounts.create'].execute({
      vaultId,
      name: 'Cash',
      nature: 'asset',
      currency: 'KRW',
    })
    const result = await tools['transactions.recordIncomeExpense'].execute({
      vaultId,
      kind: 'income',
      accountId: account.id,
      amountMinor: 100,
      occurredOn: '2026-11-08',
    })
    const edit = {
      vaultId,
      id: result.transaction.id,
      expectedRevision: result.transaction.revision,
      patch: { memo: 'Salary' },
    }
    const edited = await tools['transactions.edit'].execute(edit)
    expect(edited.transaction.revision).not.toBe(result.transaction.revision)
    await expect(tools['transactions.edit'].execute(edit)).rejects.toMatchObject({
      code: 'CONFLICT',
      application: 'not_applied',
      recovery: expect.stringContaining('Read the latest'),
    })
    const before = await tools['changes.list'].execute({ vaultId })
    const noop = await tools['transactions.edit'].execute({
      ...edit,
      expectedRevision: edited.transaction.revision,
    })
    expect(noop.changed).toBe(false)
    expect(await tools['changes.list'].execute({ vaultId })).toEqual(before)
    expect(await tools['balances.query'].execute({ vaultId })).toEqual(
      await (await access.getFin(vaultId)).queryBalances(),
    )
    await tools['transactions.delete'].execute({
      vaultId,
      id: edited.transaction.id,
      expectedRevision: edited.transaction.revision,
    })
    const records = await tools['changes.list'].execute({
      vaultId,
      targetId: edited.transaction.id,
    })
    expect(records.find((record) => record.action === 'updated')).toMatchObject({
      before: { transaction: result.transaction },
      after: { transaction: edited.transaction },
    })
    const deletion = records.find((record) => record.action === 'deleted')
    if (!deletion) throw new Error('Expected deletion history')
    const recreated = await tools['transactions.recreate'].execute({
      vaultId,
      changeRecordId: deletion.id,
    })
    expect(recreated.transaction.id).not.toBe(edited.transaction.id)
  })

  test('authorizes direct IDs and rejects unknown fields, invalid amounts and dates before access', async () => {
    const { tools, storage, access } = await fixture()
    const hidden = await createVault({ storage, name: 'Secret' })
    expect(await tools['vaults.resolve'].execute({ name: 'Secret' })).toEqual([])
    await expect(
      tools['balances.query'].execute({ vaultId: hidden.vault.id }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const getFin = vi.spyOn(access, 'getFin')
    for (const input of [
      { vaultId: 'id', kind: 'income', amountMinor: Number.MAX_SAFE_INTEGER + 1 },
      { vaultId: 'id', kind: 'income', amountMinor: 1, occurredOn: '2026-02-30' },
      { vaultId: 'id', kind: 'income', amountMinor: 1, userId: 'untrusted' },
      { kind: 'income', amountMinor: 1 },
    ]) {
      // Deliberately untrusted JSON is validated by the published schema before execution.
      await expect(
        tools['transactions.recordIncomeExpense'].execute(JSON.parse(JSON.stringify(input))),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT', application: 'not_applied' })
    }
    expect(getFin).not.toHaveBeenCalled()
  })

  test('passes classification revisions and spending filters through tools', async () => {
    const { tools } = await fixture()
    const { vault } = await tools['vaults.create'].execute({ name: 'Ledger' })
    const vaultId = vault.id
    const { account } = await tools['accounts.create'].execute({
      vaultId,
      name: 'Cash',
      nature: 'asset',
      currency: 'KRW',
    })
    const { category } = await tools['categories.create'].execute({ vaultId, name: 'Food' })
    const { transaction } = await tools['transactions.recordIncomeExpense'].execute({
      vaultId,
      kind: 'expense',
      accountId: account.id,
      amountMinor: 100,
      occurredOn: '2026-11-08',
    })
    const assignments = [{ categoryId: category.id, amountMinor: 100, origin: 'explicit' }]
    const classified = await tools['transactions.setCategoryAssignments'].execute({
      vaultId,
      id: transaction.id,
      expectedRevision: transaction.revision,
      assignments: [{ categoryId: category.id, amountMinor: 100, origin: 'explicit' }],
    })
    expect(classified.transaction.assignments).toEqual(assignments)
    await tools['transactions.recordIncomeExpense'].execute({
      vaultId,
      kind: 'expense',
      accountId: account.id,
      amountMinor: 40,
      occurredOn: '2026-11-08',
    })
    const spending = await tools['spending.query'].execute({ vaultId, categoryId: category.id })
    expect(spending.transactions.map((item) => item.id)).toEqual([transaction.id])
    expect(spending.categoryRollups).toEqual([
      { categoryId: category.id, categoryPath: 'Food', currency: 'KRW', amountMinor: 100 },
    ])
  })
})

test('tool assembly performs no I/O, selection is exact, and access fails closed', async () => {
  const access: FinVaultAccess = { listVaults: vi.fn(), createVault: vi.fn(), getFin: vi.fn() }
  const tools = createFinTools({ tools: ['vaults.list', 'balances.query'], access })
  expect(Object.keys(tools)).toEqual(['vaults.list', 'balances.query'])
  expect(access.listVaults).not.toHaveBeenCalled()
  expect(access.getFin).not.toHaveBeenCalled()
  await expect(
    createFinTools({ tools: ['vaults.list'] })['vaults.list'].execute({}),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(() => createFinTools(JSON.parse('{"tools":["missing"]}'))).toThrow('Unknown tool')
})

test('one shared tool catalog preserves interleaved per-call authorization without replay', async () => {
  const tools = createFinTools({ tools: ['vaults.list', 'vaults.create'] })
  const a: FinVaultAccess = {
    listVaults: async () => {
      await Promise.resolve()
      return [{ id: 'a', name: 'A', archived: false, revision: '1' }]
    },
    createVault: vi.fn(),
    getFin: vi.fn(),
  }
  const b: FinVaultAccess = {
    ...a,
    listVaults: async () => [{ id: 'b', name: 'B', archived: false, revision: '1' }],
  }
  const result = await Promise.all([
    tools['vaults.list'].execute({}, a),
    tools['vaults.list'].execute({}, b),
  ])
  expect(result.map((vaults) => vaults.map((vault) => vault.id))).toEqual([['a'], ['b']])
  const failure = new FinError('OUTCOME_UNKNOWN', 'Lost response', 'Inspect history', 'unknown')
  const create = vi.fn().mockRejectedValue(failure)
  await expect(
    tools['vaults.create'].execute({ name: 'Home' }, { ...a, createVault: create }),
  ).rejects.toBe(failure)
  expect(create).toHaveBeenCalledTimes(1)
})
