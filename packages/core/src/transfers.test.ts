import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  archiveAccount,
  createAccount,
  createCategory,
  initializeVault,
  listAccounts,
  recordAdjustment,
  recordIncomeExpense,
  recordTransfer,
  setCategoryAssignments,
} from './index.js'

describe('Transfer operations', () => {
  const temporaryDirectories: string[] = []

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { force: true, recursive: true })
    }
  })

  it('records a same-currency Transfer with equal source and destination amounts', () => {
    const vaultPath = createVault()
    const source = createAccount(vaultPath, {
      name: 'Source',
      nature: 'asset',
      currency: 'KRW',
    }).account
    const destination = createAccount(vaultPath, {
      name: 'Destination',
      nature: 'asset',
      currency: 'KRW',
    }).account

    const result = recordTransfer(vaultPath, {
      sourceAccountId: source.id,
      sourceAmountMinor: 30_000,
      destinationAccountId: destination.id,
      destinationAmountMinor: 30_000,
      occurredOn: '2026-07-27',
      memo: '  move savings  ',
    })

    expect(result).toEqual({
      action: 'created',
      transaction: {
        id: 1,
        kind: 'transfer',
        occurredOn: '2026-07-27',
        source: {
          account: {
            id: source.id,
            name: 'Source',
            nature: 'asset',
            currency: 'KRW',
            archived: false,
          },
          amountMinor: 30_000,
        },
        destination: {
          account: {
            id: destination.id,
            name: 'Destination',
            nature: 'asset',
            currency: 'KRW',
            archived: false,
          },
          amountMinor: 30_000,
        },
        memo: 'move savings',
      },
      sourcePreviousBalanceMinor: 0,
      sourceResultingBalanceMinor: -30_000,
      destinationPreviousBalanceMinor: 0,
      destinationResultingBalanceMinor: 30_000,
    })
    expect(() =>
      recordTransfer(vaultPath, {
        sourceAccountId: source.id,
        sourceAmountMinor: 10_000,
        destinationAccountId: destination.id,
        destinationAmountMinor: 9_000,
        occurredOn: '2026-07-28',
      }),
    ).toThrow(/Same-currency Transfer amounts must match/)
  })

  it('stores actual source and destination amounts for a cross-currency Transfer', () => {
    const vaultPath = createVault()
    const dollars = createAccount(vaultPath, {
      name: 'Dollars',
      nature: 'asset',
      currency: 'USD',
    }).account
    const won = createAccount(vaultPath, {
      name: 'Won',
      nature: 'asset',
      currency: 'KRW',
    }).account

    const result = recordTransfer(vaultPath, {
      sourceAccountId: dollars.id,
      sourceAmountMinor: 10_000,
      destinationAccountId: won.id,
      destinationAmountMinor: 135_000,
      occurredOn: '2026-07-27',
    })

    expect(result.transaction.source.amountMinor).toBe(10_000)
    expect(result.transaction.source.account.currency).toBe('USD')
    expect(result.transaction.destination.amountMinor).toBe(135_000)
    expect(result.transaction.destination.account.currency).toBe('KRW')
    expect(result.sourceResultingBalanceMinor).toBe(-10_000)
    expect(result.destinationResultingBalanceMinor).toBe(135_000)
  })

  it('applies the correct balance direction for every Account nature combination', () => {
    const combinations = [
      {
        sourceNature: 'asset',
        destinationNature: 'asset',
        sourceBalance: -100,
        destinationBalance: 100,
      },
      {
        sourceNature: 'asset',
        destinationNature: 'liability',
        sourceBalance: -100,
        destinationBalance: -100,
      },
      {
        sourceNature: 'liability',
        destinationNature: 'asset',
        sourceBalance: 100,
        destinationBalance: 100,
      },
      {
        sourceNature: 'liability',
        destinationNature: 'liability',
        sourceBalance: 100,
        destinationBalance: -100,
      },
    ] as const

    for (const [index, combination] of combinations.entries()) {
      const vaultPath = createVault()
      const source = createAccount(vaultPath, {
        name: `Source ${index}`,
        nature: combination.sourceNature,
        currency: 'KRW',
      }).account
      const destination = createAccount(vaultPath, {
        name: `Destination ${index}`,
        nature: combination.destinationNature,
        currency: 'KRW',
      }).account

      const result = recordTransfer(vaultPath, {
        sourceAccountId: source.id,
        sourceAmountMinor: 100,
        destinationAccountId: destination.id,
        destinationAmountMinor: 100,
        occurredOn: '2026-07-27',
      })

      expect(result.sourceResultingBalanceMinor).toBe(combination.sourceBalance)
      expect(result.destinationResultingBalanceMinor).toBe(combination.destinationBalance)
    }
  })

  it('pays a credit card without recording another Expense', () => {
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
    recordAdjustment(vaultPath, {
      accountId: bank.id,
      amountMinor: 1_000_000,
      occurredOn: '2026-07-25',
    })
    recordIncomeExpense(vaultPath, {
      kind: 'expense',
      accountId: card.id,
      amountMinor: 300_000,
      occurredOn: '2026-07-26',
      memo: 'card purchases',
    })

    const payment = recordTransfer(vaultPath, {
      sourceAccountId: bank.id,
      sourceAmountMinor: 300_000,
      destinationAccountId: card.id,
      destinationAmountMinor: 300_000,
      occurredOn: '2026-07-27',
      memo: 'card payment',
    })
    const database = openDatabase(vaultPath)
    const expenseCount = database
      .prepare("SELECT count(*) AS count FROM transactions WHERE kind = 'expense'")
      .get() as { count: number }
    database.close()

    expect(payment.sourceResultingBalanceMinor).toBe(700_000)
    expect(payment.destinationPreviousBalanceMinor).toBe(300_000)
    expect(payment.destinationResultingBalanceMinor).toBe(0)
    expect(expenseCount.count).toBe(1)
  })

  it('does not affect Income, Expense, or Category totals and requires distinct active Accounts', () => {
    const vaultPath = createVault()
    const source = createAccount(vaultPath, {
      name: 'Source',
      nature: 'asset',
      currency: 'KRW',
    }).account
    const destination = createAccount(vaultPath, {
      name: 'Destination',
      nature: 'asset',
      currency: 'KRW',
    }).account
    const category = createCategory(vaultPath, { name: 'Food' }).category

    expect(() =>
      recordTransfer(vaultPath, {
        sourceAccountId: source.id,
        sourceAmountMinor: 1,
        destinationAccountId: source.id,
        destinationAmountMinor: 1,
        occurredOn: '2026-07-27',
      }),
    ).toThrow(/must be different/)

    const transfer = recordTransfer(vaultPath, {
      sourceAccountId: source.id,
      sourceAmountMinor: 1_000,
      destinationAccountId: destination.id,
      destinationAmountMinor: 1_000,
      occurredOn: '2026-07-27',
    })
    expect(() =>
      setCategoryAssignments(vaultPath, transfer.transaction.id, [
        { categoryId: category.id, amountMinor: 1_000, origin: 'explicit' },
      ]),
    ).toThrow(/Transfer Transaction.*cannot receive Category Assignments/)
    const database = openDatabase(vaultPath)
    const incomeExpenseCount = database
      .prepare(
        `SELECT count(*) AS count
         FROM transactions
         WHERE kind IN ('income', 'expense')`,
      )
      .get() as { count: number }
    database.close()
    expect(incomeExpenseCount.count).toBe(0)

    const archivedVaultPath = createVault()
    const archivedSource = createAccount(archivedVaultPath, {
      name: 'Archived',
      nature: 'asset',
      currency: 'KRW',
    }).account
    const activeDestination = createAccount(archivedVaultPath, {
      name: 'Active',
      nature: 'asset',
      currency: 'KRW',
    }).account
    archiveAccount(archivedVaultPath, archivedSource.id)
    expect(() =>
      recordTransfer(archivedVaultPath, {
        sourceAccountId: archivedSource.id,
        sourceAmountMinor: 1,
        destinationAccountId: activeDestination.id,
        destinationAmountMinor: 1,
        occurredOn: '2026-07-27',
      }),
    ).toThrow(/Archived Source Account.*cannot receive new Transactions/)
  })

  it('writes the Transfer and its Change Record atomically', () => {
    const vaultPath = createVault()
    const source = createAccount(vaultPath, {
      name: 'Source',
      nature: 'asset',
      currency: 'KRW',
    }).account
    const destination = createAccount(vaultPath, {
      name: 'Destination',
      nature: 'asset',
      currency: 'KRW',
    }).account
    const database = openDatabase(vaultPath)
    database.exec(`
      CREATE TRIGGER test_reject_transfer_change
      BEFORE INSERT ON change_records
      WHEN NEW.entity_type = 'transaction'
      BEGIN
        SELECT RAISE(ABORT, 'forced Transfer Change Record failure');
      END;
    `)
    database.close()

    expect(() =>
      recordTransfer(vaultPath, {
        sourceAccountId: source.id,
        sourceAmountMinor: 1_000,
        destinationAccountId: destination.id,
        destinationAmountMinor: 1_000,
        occurredOn: '2026-07-27',
      }),
    ).toThrow(/forced Transfer Change Record failure/)
    expect(listAccounts(vaultPath).map(({ balanceMinor }) => balanceMinor)).toEqual([0, 0])

    const reopenedDatabase = openDatabase(vaultPath)
    reopenedDatabase.exec('DROP TRIGGER test_reject_transfer_change')
    reopenedDatabase.close()
    const result = recordTransfer(vaultPath, {
      sourceAccountId: source.id,
      sourceAmountMinor: 1_000,
      destinationAccountId: destination.id,
      destinationAmountMinor: 1_000,
      occurredOn: '2026-07-27',
    })
    const finalDatabase = openDatabase(vaultPath)
    const transactionCount = finalDatabase
      .prepare('SELECT count(*) AS count FROM transactions')
      .get() as { count: number }
    const record = finalDatabase
      .prepare(
        `SELECT payload
         FROM change_records
         WHERE entity_type = 'transaction' AND entity_id = ?`,
      )
      .get(String(result.transaction.id)) as { payload: string }
    finalDatabase.close()

    expect(transactionCount.count).toBe(1)
    expect(JSON.parse(record.payload)).toEqual(result)
  })

  function createVault(): string {
    const parentPath = mkdtempSync(join(tmpdir(), 'fin-transfer-test-'))
    temporaryDirectories.push(parentPath)
    const vaultPath = join(parentPath, 'vault')
    initializeVault(vaultPath)
    return vaultPath
  }

  function openDatabase(vaultPath: string): DatabaseSync {
    const database = new DatabaseSync(join(vaultPath, 'fin.sqlite'))
    database.exec('PRAGMA foreign_keys = ON')
    return database
  }
})
