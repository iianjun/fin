import { afterEach, describe, expect, test, vi } from 'vitest'
import { createFin, createVault, listVaults, FinError, type FinStorage } from '@fin/core'
import { createSqliteAdapter } from '@fin/sqlite'
import { openD1Fixture } from '../../d1/test/fixture.js'

// Add new real adapter fixtures here; every provider runs the same public financial contract.
const adapters: {
  name: string
  open(): Promise<{ storage: FinStorage; dispose(): void | Promise<void> }>
}[] = [
  {
    name: 'SQLite',
    async open() {
      const storage = createSqliteAdapter({ filename: ':memory:' })
      return {
        storage,
        dispose: storage.close,
      }
    },
  },
  {
    name: 'D1 REST envelope over local D1',
    open: openD1Fixture,
  },
]

describe.each(adapters)('$name financial contract', ({ open }) => {
  const disposers: (() => void | Promise<void>)[] = []
  afterEach(async () => {
    vi.useRealTimers()
    for (const dispose of disposers.splice(0)) await dispose()
  })
  async function fixture() {
    const { storage, dispose } = await open()
    disposers.push(dispose)
    const { vault } = await createVault({ storage, name: 'Household' })
    return { storage, vault, fin: createFin({ storage, vaultId: vault.id }) }
  }
  test('supports detached financial callbacks while preserving vault scope', async () => {
    const first = await fixture()
    const second = await fixture()
    const {
      createAccount,
      recordIncomeExpense,
      editTransaction,
      getAccount,
      queryBalances,
      getVault,
    } = first.fin
    const otherCreateAccount = second.fin.createAccount
    const account = (await createAccount({ name: 'Cash', nature: 'asset', currency: 'KRW' }))
      .account
    const other = (await otherCreateAccount({ name: 'Cash', nature: 'asset', currency: 'KRW' }))
      .account
    const income = await recordIncomeExpense({
      kind: 'income',
      accountId: account.id,
      amountMinor: 1000,
    })
    await editTransaction({
      id: income.transaction.id,
      expectedRevision: income.transaction.revision,
      patch: { amountMinor: 1200 },
    })
    expect((await getVault()).id).toBe(first.vault.id)
    expect((await getAccount({ id: account.id })).balanceMinor).toBe(1200)
    expect((await queryBalances()).netWorthByCurrency).toEqual([
      { currency: 'KRW', amountMinor: 1200 },
    ])
    expect((await second.fin.getAccount({ id: other.id })).balanceMinor).toBe(0)
    await expect(second.fin.getAccount({ id: account.id })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })
  test('edits a transaction at the safe-integer balance limit without rounding intermediates', async () => {
    const { fin } = await fixture()
    const account = (await fin.createAccount({ name: 'Cash', nature: 'asset', currency: 'KRW' }))
      .account
    await fin.recordIncomeExpense({
      kind: 'income',
      accountId: account.id,
      amountMinor: Number.MAX_SAFE_INTEGER,
    })
    const expense = await fin.recordIncomeExpense({
      kind: 'expense',
      accountId: account.id,
      amountMinor: 1,
    })
    await fin.recordIncomeExpense({ kind: 'income', accountId: account.id, amountMinor: 1 })
    await fin.editTransaction({
      id: expense.transaction.id,
      expectedRevision: expense.transaction.revision,
      patch: { memo: 'Corrected memo' },
    })
    expect((await fin.getAccount({ id: account.id })).balanceMinor).toBe(Number.MAX_SAFE_INTEGER)
  })
  test('retains actual cross-currency transfer amounts and detects ABA edits', async () => {
    const { fin } = await fixture()
    const usd = (await fin.createAccount({ name: 'USD', nature: 'asset', currency: 'USD' })).account
    const krw = (await fin.createAccount({ name: 'KRW', nature: 'asset', currency: 'KRW' })).account
    const transfer = await fin.recordTransfer({
      sourceAccountId: usd.id,
      sourceAmountMinor: 100,
      destinationAccountId: krw.id,
      destinationAmountMinor: 1400,
    })
    expect((await fin.queryBalances()).netWorthByCurrency).toEqual([
      { currency: 'KRW', amountMinor: 1400 },
      { currency: 'USD', amountMinor: -100 },
    ])
    const first = await fin.editTransaction({
      id: transfer.transaction.id,
      expectedRevision: transfer.transaction.revision,
      patch: { memo: 'Changed' },
    })
    const restored = await fin.editTransaction({
      id: first.transaction.id,
      expectedRevision: first.transaction.revision,
      patch: { memo: null },
    })
    expect(restored.transaction.revision).not.toBe(transfer.transaction.revision)
    await expect(
      fin.editTransaction({
        id: transfer.transaction.id,
        expectedRevision: transfer.transaction.revision,
        patch: { memo: null },
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })
  // Creating 32 categories uses sequential public storage calls; workerd IPC on
  // Windows can exceed the default 5s budget before the classification checks.
  test(
    'commits the maximum classification set atomically and rejects larger sets',
    { timeout: 20_000 },
    async () => {
      const { fin } = await fixture()
      const account = (await fin.createAccount({ name: 'Cash', nature: 'asset', currency: 'KRW' }))
        .account
      const assignments = []
      for (let index = 0; index < 32; index++)
        assignments.push({
          categoryId: (await fin.createCategory({ name: `Category ${index}` })).category.id,
          amountMinor: 1,
          origin: 'explicit' as const,
        })
      const result = await fin.recordIncomeExpense({
        kind: 'expense',
        accountId: account.id,
        amountMinor: 32,
        assignments,
      })
      expect((await fin.getTransaction({ id: result.transaction.id })).assignments).toHaveLength(32)
      const before = await fin.listChangeRecords()
      await expect(
        fin.setCategoryAssignments({
          id: result.transaction.id,
          expectedRevision: result.transaction.revision,
          assignments: [
            ...assignments,
            { categoryId: 'extra', amountMinor: 1, origin: 'explicit' },
          ],
        }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT', application: 'not_applied' })
      expect(await fin.listChangeRecords()).toEqual(before)
      expect((await fin.getAccount({ id: account.id })).balanceMinor).toBe(-32)
    },
  )
  test('uses host calendar dates and persistent defaults without converting explicit dates', async () => {
    const { storage, vault, fin } = await fixture()
    const account = (await fin.createAccount({ name: 'Cash', nature: 'asset', currency: 'KRW' }))
      .account
    await fin.setDefaultAccount({
      kind: 'expense',
      accountId: account.id,
      expectedRevision: (await fin.getSettings()).revision,
    })
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-31T15:30:00.000Z'))
    const seoul = createFin({ storage, vaultId: vault.id, timeZone: 'Asia/Seoul' })
    const applied = await seoul.recordIncomeExpense({ kind: 'expense', amountMinor: 1 })
    expect(applied.transaction.occurredOn).toBe('2026-11-01')
    expect(applied).toMatchObject({ dateDefaulted: true, accountDefaulted: true })
    const utc = createFin({ storage, vaultId: vault.id, timeZone: 'UTC' })
    expect(
      (await utc.recordIncomeExpense({ kind: 'expense', amountMinor: 2 })).transaction.occurredOn,
    ).toBe('2026-10-31')
    expect(
      (
        await seoul.recordIncomeExpense({
          kind: 'expense',
          amountMinor: 3,
          occurredOn: '2026-02-28',
        })
      ).transaction.occurredOn,
    ).toBe('2026-02-28')
  })

  test('rejects invalid filters and oversized inputs without changing financial state', async () => {
    const { fin } = await fixture()
    const account = (await fin.createAccount({ name: 'Cash', nature: 'asset', currency: 'KRW' }))
      .account
    await fin.recordIncomeExpense({
      kind: 'income',
      accountId: account.id,
      amountMinor: Number.MAX_SAFE_INTEGER,
    })
    const before = await fin.getAccount({ id: account.id })
    await expect(
      fin.recordIncomeExpense({ kind: 'income', accountId: account.id, amountMinor: 1 }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT', application: 'not_applied' })
    await expect(fin.listTransactions({ dateFrom: '2026-02-30' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    })
    await expect(fin.listTransactions({ limit: -1 })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    })
    await expect(fin.getAccount({ id: '' })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(await fin.getAccount({ id: account.id })).toEqual(before)
    expect(await fin.listTransactions()).toHaveLength(1)
  })

  test('enforces category depth and sibling names while retaining current paths', async () => {
    const { fin } = await fixture()
    const root = (await fin.createCategory({ name: 'Food' })).category
    const child = (await fin.createCategory({ name: 'Cafe', parentId: root.id })).category
    const leaf = (await fin.createCategory({ name: 'Coffee', parentId: child.id })).category
    expect(leaf.path).toBe('Food / Cafe / Coffee')
    await expect(fin.createCategory({ name: 'Fourth', parentId: leaf.id })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    })
    await expect(fin.createCategory({ name: 'Cafe', parentId: root.id })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    })
    await expect(
      fin.updateCategory({
        id: root.id,
        expectedRevision: root.revision,
        patch: { parentId: child.id },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await fin.updateCategory({
      id: root.id,
      expectedRevision: root.revision,
      patch: { name: 'Dining' },
    })
    expect((await fin.listCategories()).find((c) => c.id === leaf.id)?.path).toBe(
      'Dining / Cafe / Coffee',
    )
  })

  test('manages accounts and persistent defaults with revisions and no-op history', async () => {
    const { fin } = await fixture()
    const { account } = await fin.createAccount({ name: 'Cash', nature: 'asset', currency: 'KRW' })
    expect(account).toMatchObject({ balanceMinor: 0, archived: false, currency: 'KRW' })
    const settings = await fin.getSettings()
    const saved = await fin.setDefaultAccount({
      kind: 'expense',
      accountId: account.id,
      expectedRevision: settings.revision,
    })
    expect((await fin.getSettings()).expenseAccountId).toBe(account.id)
    const noOp = await fin.setDefaultAccount({
      kind: 'expense',
      accountId: account.id,
      expectedRevision: saved.settings.revision,
    })
    expect(noOp.changed).toBe(false)
    const renamed = await fin.updateAccount({
      id: account.id,
      expectedRevision: account.revision,
      patch: { name: 'Wallet' },
    })
    await expect(
      fin.updateAccount({
        id: account.id,
        expectedRevision: account.revision,
        patch: { name: 'Wallet' },
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT', application: 'not_applied' })
    const archived = await fin.updateAccount({
      id: account.id,
      expectedRevision: renamed.account.revision,
      patch: { archived: true },
    })
    expect(archived.account.archived).toBe(true)
    expect((await fin.getSettings()).expenseAccountId).toBeNull()
    expect(await fin.listAccounts()).toEqual([])
    expect(await fin.listAccounts({ includeArchived: true })).toHaveLength(1)
    expect(await fin.listChangeRecords()).toHaveLength(5)
  })

  test('records income, expenses and refunds with derived asset and liability balances', async () => {
    const { fin } = await fixture()
    const cash = (await fin.createAccount({ name: 'Cash', nature: 'asset', currency: 'KRW' }))
      .account
    const card = (await fin.createAccount({ name: 'Card', nature: 'liability', currency: 'KRW' }))
      .account
    const income = await fin.recordIncomeExpense({
      kind: 'income',
      accountId: cash.id,
      amountMinor: 10000,
      occurredOn: '2026-10-31',
    })
    expect(income.balances).toEqual([
      { accountId: cash.id, previousBalanceMinor: 0, resultingBalanceMinor: 10000 },
    ])
    await fin.recordIncomeExpense({
      kind: 'expense',
      accountId: cash.id,
      amountMinor: 3000,
      occurredOn: '2026-10-31',
      memo: 'Coffee',
    })
    const expense = await fin.recordIncomeExpense({
      kind: 'expense',
      accountId: card.id,
      amountMinor: 5000,
      occurredOn: '2026-10-31',
    })
    await fin.recordRefund({
      accountId: card.id,
      amountMinor: 1000,
      originalExpenseId: expense.transaction.id,
      occurredOn: '2026-10-31',
    })
    expect((await fin.getAccount({ id: cash.id })).balanceMinor).toBe(7000)
    expect((await fin.getAccount({ id: card.id })).balanceMinor).toBe(4000)
    await expect(
      fin.recordIncomeExpense({ kind: 'income', accountId: cash.id, amountMinor: 1.5 }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(
      fin.recordIncomeExpense({
        kind: 'income',
        accountId: cash.id,
        amountMinor: 1,
        occurredOn: '2026-02-30',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    const records = await fin.listChangeRecords({ targetId: income.transaction.id })
    expect(records[0]).toMatchObject({
      before: null,
      after: { transaction: income.transaction },
      balances: income.balances,
    })
  })

  test('edits, replaces classifications, deletes and recreates with exact history and fresh identities', async () => {
    const { fin } = await fixture()
    const cash = (await fin.createAccount({ name: 'Cash', nature: 'asset', currency: 'USD' }))
      .account
    const category = (await fin.createCategory({ name: 'Food' })).category
    const created = await fin.recordIncomeExpense({
      kind: 'expense',
      accountId: cash.id,
      amountMinor: 1234,
      occurredOn: '2026-10-30',
    })
    const edited = await fin.editTransaction({
      id: created.transaction.id,
      expectedRevision: created.transaction.revision,
      patch: { memo: 'Lunch', amountMinor: 1500 },
    })
    expect(edited.balances).toEqual([
      { accountId: cash.id, previousBalanceMinor: -1234, resultingBalanceMinor: -1500 },
    ])
    const classified = await fin.setCategoryAssignments({
      id: edited.transaction.id,
      expectedRevision: edited.transaction.revision,
      assignments: [{ categoryId: category.id, amountMinor: 1000, origin: 'explicit' }],
    })
    const noOp = await fin.setCategoryAssignments({
      id: classified.transaction.id,
      expectedRevision: classified.transaction.revision,
      assignments: [{ categoryId: category.id, amountMinor: 1000, origin: 'explicit' }],
    })
    expect(noOp.changed).toBe(false)
    await expect(
      fin.editTransaction({
        id: created.transaction.id,
        expectedRevision: created.transaction.revision,
        patch: { memo: 'Lunch' },
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(
      fin.setCategoryAssignments({
        id: classified.transaction.id,
        expectedRevision: classified.transaction.revision,
        assignments: [{ categoryId: category.id, amountMinor: 1501, origin: 'inferred' }],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    const deleted = await fin.deleteTransaction({
      id: classified.transaction.id,
      expectedRevision: classified.transaction.revision,
    })
    expect(deleted.transaction).toEqual(classified.transaction)
    expect((await fin.getAccount({ id: cash.id })).balanceMinor).toBe(0)
    await expect(fin.getTransaction({ id: classified.transaction.id })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    const records = await fin.listChangeRecords({ targetId: created.transaction.id })
    const deletion = records.find((r) => r.action === 'deleted')
    expect(deletion).toMatchObject({ before: { transaction: classified.transaction }, after: null })
    if (!deletion) throw new Error('Deletion record is missing')
    const recreated = await fin.recreateTransaction({ changeRecordId: deletion.id })
    expect(recreated.transaction.id).not.toBe(created.transaction.id)
    expect(recreated.transaction).toMatchObject({
      memo: 'Lunch',
      amountMinor: 1500,
      assignments: classified.transaction.assignments,
    })
    expect((await fin.getAccount({ id: cash.id })).balanceMinor).toBe(-1500)
  })

  test('transfers value and adjusts target balances using balance revisions', async () => {
    const { fin } = await fixture()
    const cash = (await fin.createAccount({ name: 'Bank', nature: 'asset', currency: 'KRW' }))
      .account
    const card = (await fin.createAccount({ name: 'Card', nature: 'liability', currency: 'KRW' }))
      .account
    const initial = await fin.adjustAccountBalance({
      accountId: cash.id,
      expectedRevision: cash.balanceRevision,
      targetBalanceMinor: 10000,
    })
    expect(initial.balances).toEqual([
      { accountId: cash.id, previousBalanceMinor: 0, resultingBalanceMinor: 10000 },
    ])
    await fin.recordIncomeExpense({ kind: 'expense', accountId: card.id, amountMinor: 4000 })
    const transfer = await fin.recordTransfer({
      sourceAccountId: cash.id,
      sourceAmountMinor: 4000,
      destinationAccountId: card.id,
      destinationAmountMinor: 4000,
    })
    expect((await fin.getAccount({ id: card.id })).balanceMinor).toBe(0)
    const fee = await fin.recordTransferFee({
      transferId: transfer.transaction.id,
      accountId: cash.id,
      amountMinor: 100,
    })
    expect((await fin.getAccount({ id: cash.id })).balanceMinor).toBe(5900)
    await expect(
      fin.adjustAccountBalance({
        accountId: cash.id,
        expectedRevision: cash.balanceRevision,
        targetBalanceMinor: 6000,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    const current = await fin.getAccount({ id: cash.id })
    const noOp = await fin.adjustAccountBalance({
      accountId: cash.id,
      expectedRevision: current.balanceRevision,
      targetBalanceMinor: 5900,
    })
    expect(noOp.changed).toBe(false)
    await fin.deleteTransaction({
      id: transfer.transaction.id,
      expectedRevision: (await fin.getTransaction({ id: transfer.transaction.id })).revision,
    })
    expect((await fin.getTransaction({ id: fee.transaction.id })).relations).toEqual([])
    expect((await fin.queryBalances()).netWorthByCurrency).toEqual([
      { currency: 'KRW', amountMinor: 5900 },
    ])
    await expect(
      fin.recordTransfer({
        sourceAccountId: cash.id,
        sourceAmountMinor: 100,
        destinationAccountId: card.id,
        destinationAmountMinor: 101,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  test('isolates vaults and rejects financial writes after explicit archival', async () => {
    const { storage, vault, fin } = await fixture()
    const second = (await createVault({ storage, name: 'Work' })).vault
    const other = createFin({ storage, vaultId: second.id })
    const account = (await other.createAccount({ name: 'Cash', nature: 'asset', currency: 'KRW' }))
      .account
    await expect(
      fin.recordIncomeExpense({ kind: 'income', accountId: account.id, amountMinor: 100 }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(await fin.listAccounts()).toEqual([])
    const renamed = await fin.updateVault({
      expectedRevision: vault.revision,
      patch: { name: 'Personal' },
    })
    expect(renamed.vault.id).toBe(vault.id)
    const archived = await fin.updateVault({
      expectedRevision: renamed.vault.revision,
      patch: { archived: true },
    })
    expect((await listVaults({ storage })).map((v) => v.id)).toEqual([second.id])
    expect(await listVaults({ storage, includeArchived: true })).toHaveLength(2)
    await expect(
      fin.createAccount({ name: 'Blocked', nature: 'asset', currency: 'KRW' }),
    ).rejects.toMatchObject({ code: 'VAULT_ARCHIVED' })
    expect(await fin.listChangeRecords()).toHaveLength(3)
    await fin.updateVault({ expectedRevision: archived.vault.revision, patch: { archived: false } })
    await fin.createAccount({ name: 'Cash', nature: 'asset', currency: 'KRW' })
    expect(await fin.listAccounts()).toHaveLength(1)
  })

  test('requires confirmation for likely duplicates and reports spending in current category paths', async () => {
    const { fin } = await fixture()
    const account = (await fin.createAccount({ name: 'Cash', nature: 'asset', currency: 'USD' }))
      .account
    const root = (await fin.createCategory({ name: 'Food' })).category
    const leaf = (await fin.createCategory({ name: 'Coffee', parentId: root.id })).category
    const input = {
      kind: 'expense' as const,
      accountId: account.id,
      amountMinor: 500,
      occurredOn: '2026-10-31',
      memo: 'Meeting',
      assignments: [{ categoryId: leaf.id, amountMinor: 300, origin: 'explicit' as const }],
    }
    const first = await fin.recordIncomeExpense(input)
    await expect(fin.recordIncomeExpense(input)).rejects.toMatchObject({
      code: 'DUPLICATE_CANDIDATE',
      application: 'not_applied',
    })
    await fin.recordIncomeExpense({ ...input, allowDuplicate: true })
    const result = await fin.querySpending({ categoryId: root.id, search: 'coffee' })
    expect(result.expenseTotalsByCurrency).toEqual([{ currency: 'USD', amountMinor: 1000 }])
    expect(result.uncategorizedByCurrency).toEqual([{ currency: 'USD', amountMinor: 400 }])
    expect(result.categoryRollups.find((r) => r.categoryId === root.id)).toMatchObject({
      categoryPath: 'Food',
      amountMinor: 600,
    })
    await fin.updateCategory({
      id: root.id,
      expectedRevision: root.revision,
      patch: { name: 'Dining' },
    })
    expect((await fin.getTransaction({ id: first.transaction.id })).revision).toBe(
      first.transaction.revision,
    )
    expect(
      (await fin.querySpending({ search: 'Dining' })).categoryRollups.map((r) => r.categoryPath),
    ).toContain('Dining / Coffee')
    expect(await fin.listTransactions({ dateTo: '2026-10-30' })).toEqual([])
  })

  test('does not repeat a write after an injected lost commit response', async () => {
    const { storage, vault, fin } = await fixture()
    const account = (await fin.createAccount({ name: 'Cash', nature: 'asset', currency: 'KRW' }))
      .account
    let commits = 0
    const uncertain: FinStorage = {
      read: (request) => storage.read(request),
      async mutate(request, decide) {
        await storage.mutate(request, decide)
        commits++
        throw new FinError(
          'OUTCOME_UNKNOWN',
          'The commit response was lost.',
          'Inspect transactions and change records before deciding what to do.',
          'unknown',
        )
      },
    }
    const client = createFin({ storage: uncertain, vaultId: vault.id })
    await expect(
      client.recordIncomeExpense({ kind: 'income', accountId: account.id, amountMinor: 100 }),
    ).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN', application: 'unknown' })
    expect(commits).toBe(1)
    expect(await fin.listTransactions()).toHaveLength(1)
    expect((await fin.getAccount({ id: account.id })).balanceMinor).toBe(100)
  })
})
