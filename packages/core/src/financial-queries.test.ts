import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  archiveAccount,
  createAccount,
  createCategory,
  initializeVault,
  queryBalances,
  querySpending,
  queryTransactions,
  recordAdjustment,
  recordIncomeExpense,
  recordRefund,
  recordTransfer,
  setCategoryAssignments,
  updateCategory,
} from './index.js'

describe('Financial queries', () => {
  const temporaryDirectories: string[] = []

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { force: true, recursive: true })
    }
  })

  it('reports every Account and keeps net worth separated by currency', () => {
    const vaultPath = createVault()
    const bank = createAccount(vaultPath, {
      name: 'Bank',
      nature: 'asset',
      currency: 'KRW',
    }).account
    const card = createAccount(vaultPath, {
      name: 'Card',
      nature: 'liability',
      currency: 'KRW',
    }).account
    const dollars = createAccount(vaultPath, {
      name: 'Dollars',
      nature: 'asset',
      currency: 'USD',
    }).account
    const dormant = createAccount(vaultPath, {
      name: 'Dormant',
      nature: 'asset',
      currency: 'KRW',
    }).account
    recordIncomeExpense(vaultPath, {
      kind: 'income',
      accountId: bank.id,
      amountMinor: 100_000,
      occurredOn: '2026-07-20',
    })
    recordIncomeExpense(vaultPath, {
      kind: 'expense',
      accountId: card.id,
      amountMinor: 30_000,
      occurredOn: '2026-07-20',
    })
    recordAdjustment(vaultPath, {
      accountId: dollars.id,
      amountMinor: 5_000,
      occurredOn: '2026-07-20',
    })
    archiveAccount(vaultPath, dormant.id)

    const result = queryBalances(vaultPath)

    expect(result.accounts).toEqual([
      {
        ...bank,
        balanceMinor: 100_000,
      },
      {
        ...card,
        balanceMinor: 30_000,
      },
      {
        ...dollars,
        balanceMinor: 5_000,
      },
      {
        ...dormant,
        archived: true,
        balanceMinor: 0,
      },
    ])
    expect(result.netWorthByCurrency).toEqual([
      { currency: 'KRW', amountMinor: 70_000 },
      { currency: 'USD', amountMinor: 5_000 },
    ])
  })

  it('filters by date, Account, kind, and memo while excluding Transfers and Adjustments from totals', () => {
    const vaultPath = createVault()
    const bank = createAssetAccount(vaultPath, 'Bank', 'KRW')
    const savings = createAssetAccount(vaultPath, 'Savings', 'KRW')
    const dollars = createAssetAccount(vaultPath, 'Dollars', 'USD')
    const salary = recordIncomeExpense(vaultPath, {
      kind: 'income',
      accountId: bank.id,
      amountMinor: 100_000,
      occurredOn: '2026-07-20',
      memo: 'salary',
    }).transaction
    const coffee = recordIncomeExpense(vaultPath, {
      kind: 'expense',
      accountId: bank.id,
      amountMinor: 30_000,
      occurredOn: '2026-07-21',
      memo: 'Coffee Beans',
    }).transaction
    const refund = recordRefund(vaultPath, {
      accountId: bank.id,
      amountMinor: 10_000,
      occurredOn: '2026-07-22',
      memo: 'coffee refund',
      originalExpenseId: coffee.id,
    }).transaction
    const adjustment = recordAdjustment(vaultPath, {
      accountId: bank.id,
      amountMinor: 500,
      occurredOn: '2026-07-21',
      memo: 'rounding',
    }).transaction
    const transfer = recordTransfer(vaultPath, {
      sourceAccountId: bank.id,
      sourceAmountMinor: 5_000,
      destinationAccountId: savings.id,
      destinationAmountMinor: 5_000,
      occurredOn: '2026-07-23',
      memo: 'move',
    }).transaction
    const usdIncome = recordIncomeExpense(vaultPath, {
      kind: 'income',
      accountId: dollars.id,
      amountMinor: 5_000,
      occurredOn: '2026-07-20',
      memo: 'USD income',
    }).transaction
    const usdExpense = recordIncomeExpense(vaultPath, {
      kind: 'expense',
      accountId: dollars.id,
      amountMinor: 1_200,
      occurredOn: '2026-07-21',
      memo: 'USD expense',
    }).transaction

    const all = queryTransactions(vaultPath)

    expect(all.transactions.map((transaction) => transaction.id)).toEqual([
      salary.id,
      usdIncome.id,
      coffee.id,
      adjustment.id,
      usdExpense.id,
      refund.id,
      transfer.id,
    ])
    expect(all.incomeExpenseTotalsByCurrency).toEqual([
      {
        currency: 'KRW',
        incomeMinor: 100_000,
        expenseMinor: 20_000,
        netIncomeMinor: 80_000,
        transactionIds: [salary.id, coffee.id, refund.id],
      },
      {
        currency: 'USD',
        incomeMinor: 5_000,
        expenseMinor: 1_200,
        netIncomeMinor: 3_800,
        transactionIds: [usdIncome.id, usdExpense.id],
      },
    ])

    const filtered = queryTransactions(vaultPath, {
      dateFrom: '2026-07-21',
      dateTo: '2026-07-22',
      accountId: bank.id,
      kinds: ['expense'],
      memoContains: 'COFFEE',
    })

    expect(filtered.filters).toEqual({
      dateFrom: '2026-07-21',
      dateTo: '2026-07-22',
      accountId: bank.id,
      kinds: ['expense'],
      memoContains: 'COFFEE',
    })
    expect(filtered.transactions.map((transaction) => transaction.id)).toEqual([
      coffee.id,
      refund.id,
    ])
    expect(filtered.transactions[0]).toMatchObject({
      kind: 'expense',
      account: { id: bank.id, currency: 'KRW' },
      amountMinor: 30_000,
      memo: 'Coffee Beans',
      uncategorizedAmountMinor: 30_000,
    })
    expect(filtered.transactions[1]).toMatchObject({
      kind: 'expense',
      amountMinor: -10_000,
      relations: [
        {
          relationKind: 'refund_of',
          direction: 'outgoing',
          relatedTransactionId: coffee.id,
        },
      ],
    })
    expect(filtered.incomeExpenseTotalsByCurrency[0]).toEqual({
      currency: 'KRW',
      incomeMinor: 0,
      expenseMinor: 20_000,
      netIncomeMinor: -20_000,
      transactionIds: [coffee.id, refund.id],
    })

    const transfersForSavings = queryTransactions(vaultPath, {
      accountId: savings.id,
      kinds: ['transfer'],
    })
    expect(transfersForSavings.transactions).toHaveLength(1)
    expect(transfersForSavings.transactions[0]).toMatchObject({
      id: transfer.id,
      kind: 'transfer',
      source: { account: { id: bank.id }, amountMinor: 5_000 },
      destination: { account: { id: savings.id }, amountMinor: 5_000 },
    })
    expect(transfersForSavings.incomeExpenseTotalsByCurrency).toEqual([])
  })

  it('rolls up current Category paths, exposes uncategorized amounts, and matches memo text', () => {
    const vaultPath = createVault()
    const bank = createAssetAccount(vaultPath, 'Bank', 'KRW')
    const dollars = createAssetAccount(vaultPath, 'Dollars', 'USD')
    const living = createCategory(vaultPath, { name: 'Living' }).category
    const food = createCategory(vaultPath, {
      name: 'Food',
      parentId: living.id,
    }).category
    const coffeeCategory = createCategory(vaultPath, {
      name: 'Coffee',
      parentId: food.id,
    }).category
    const morningCoffee = recordIncomeExpense(vaultPath, {
      kind: 'expense',
      accountId: bank.id,
      amountMinor: 1_000,
      occurredOn: '2026-07-20',
      memo: 'Morning coffee',
    }).transaction
    setCategoryAssignments(vaultPath, morningCoffee.id, [
      {
        categoryId: coffeeCategory.id,
        amountMinor: 700,
        origin: 'explicit',
      },
    ])
    const groceries = recordIncomeExpense(vaultPath, {
      kind: 'expense',
      accountId: bank.id,
      amountMinor: 500,
      occurredOn: '2026-07-21',
      memo: 'groceries',
    }).transaction
    setCategoryAssignments(vaultPath, groceries.id, [
      {
        categoryId: food.id,
        amountMinor: 500,
        origin: 'explicit',
      },
    ])
    const refund = recordRefund(vaultPath, {
      accountId: bank.id,
      amountMinor: 200,
      occurredOn: '2026-07-22',
      memo: 'coffee refund',
      originalExpenseId: morningCoffee.id,
    }).transaction
    setCategoryAssignments(vaultPath, refund.id, [
      {
        categoryId: coffeeCategory.id,
        amountMinor: -200,
        origin: 'explicit',
      },
    ])
    const abroad = recordIncomeExpense(vaultPath, {
      kind: 'expense',
      accountId: dollars.id,
      amountMinor: 100,
      occurredOn: '2026-07-23',
      memo: 'Coffee abroad',
    }).transaction
    setCategoryAssignments(vaultPath, abroad.id, [
      {
        categoryId: coffeeCategory.id,
        amountMinor: 100,
        origin: 'inferred',
      },
    ])
    updateCategory(vaultPath, coffeeCategory.id, { name: 'Cafes' })

    const all = querySpending(vaultPath)

    expect(all.expenseTotalsByCurrency).toEqual([
      { currency: 'KRW', amountMinor: 1_300 },
      { currency: 'USD', amountMinor: 100 },
    ])
    expect(all.uncategorizedByCurrency).toEqual([
      { currency: 'KRW', amountMinor: 300 },
      { currency: 'USD', amountMinor: 0 },
    ])
    expect(all.categoryRollups).toEqual([
      {
        categoryId: living.id,
        categoryPath: 'Living',
        currency: 'KRW',
        amountMinor: 1_000,
        transactionIds: [morningCoffee.id, groceries.id, refund.id],
      },
      {
        categoryId: food.id,
        categoryPath: 'Living > Food',
        currency: 'KRW',
        amountMinor: 1_000,
        transactionIds: [morningCoffee.id, groceries.id, refund.id],
      },
      {
        categoryId: coffeeCategory.id,
        categoryPath: 'Living > Food > Cafes',
        currency: 'KRW',
        amountMinor: 500,
        transactionIds: [morningCoffee.id, refund.id],
      },
      {
        categoryId: living.id,
        categoryPath: 'Living',
        currency: 'USD',
        amountMinor: 100,
        transactionIds: [abroad.id],
      },
      {
        categoryId: food.id,
        categoryPath: 'Living > Food',
        currency: 'USD',
        amountMinor: 100,
        transactionIds: [abroad.id],
      },
      {
        categoryId: coffeeCategory.id,
        categoryPath: 'Living > Food > Cafes',
        currency: 'USD',
        amountMinor: 100,
        transactionIds: [abroad.id],
      },
    ])
    expect(all.transactions[0]).toMatchObject({
      id: morningCoffee.id,
      amountMinor: 1_000,
      assignments: [
        {
          categoryPath: 'Living > Food > Cafes',
          amountMinor: 700,
        },
      ],
      uncategorizedAmountMinor: 300,
    })

    const coffeeMemo = querySpending(vaultPath, {
      memoContains: 'coffee',
    })
    expect(coffeeMemo.transactions.map((transaction) => transaction.id)).toEqual([
      morningCoffee.id,
      refund.id,
      abroad.id,
    ])
    expect(coffeeMemo.expenseTotalsByCurrency).toEqual([
      { currency: 'KRW', amountMinor: 800 },
      { currency: 'USD', amountMinor: 100 },
    ])
    expect(coffeeMemo.uncategorizedByCurrency).toEqual([
      { currency: 'KRW', amountMinor: 300 },
      { currency: 'USD', amountMinor: 0 },
    ])

    const foodRollup = querySpending(vaultPath, {
      categoryId: food.id,
    })
    expect(foodRollup.transactions.map((transaction) => transaction.id)).toEqual([
      morningCoffee.id,
      groceries.id,
      refund.id,
      abroad.id,
    ])
    expect(foodRollup.categoryRollups).toEqual([
      {
        categoryId: food.id,
        categoryPath: 'Living > Food',
        currency: 'KRW',
        amountMinor: 1_000,
        transactionIds: [morningCoffee.id, groceries.id, refund.id],
      },
      {
        categoryId: coffeeCategory.id,
        categoryPath: 'Living > Food > Cafes',
        currency: 'KRW',
        amountMinor: 500,
        transactionIds: [morningCoffee.id, refund.id],
      },
      {
        categoryId: food.id,
        categoryPath: 'Living > Food',
        currency: 'USD',
        amountMinor: 100,
        transactionIds: [abroad.id],
      },
      {
        categoryId: coffeeCategory.id,
        categoryPath: 'Living > Food > Cafes',
        currency: 'USD',
        amountMinor: 100,
        transactionIds: [abroad.id],
      },
    ])
  })

  it('rejects invalid query ranges, empty memo searches, and missing Categories', () => {
    const vaultPath = createVault()

    expect(() =>
      queryTransactions(vaultPath, {
        dateFrom: '2026-07-28',
        dateTo: '2026-07-27',
      }),
    ).toThrow(/dateFrom must be on or before dateTo/)
    expect(() =>
      queryTransactions(vaultPath, {
        memoContains: '   ',
      }),
    ).toThrow(/Memo search text must not be empty/)
    expect(() => querySpending(vaultPath, { categoryId: 99 })).toThrow(/Category 99 does not exist/)
  })

  function createVault(): string {
    const vaultPath = mkdtempSync(join(tmpdir(), 'fin-financial-queries-'))
    temporaryDirectories.push(vaultPath)
    initializeVault(vaultPath)
    return vaultPath
  }
})

function createAssetAccount(vaultPath: string, name: string, currency: string) {
  return createAccount(vaultPath, {
    name,
    nature: 'asset',
    currency,
  }).account
}
