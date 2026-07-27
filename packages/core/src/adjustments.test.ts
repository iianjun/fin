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
  setCategoryAssignments,
} from './index.js'

describe('Adjustment operations', () => {
  const temporaryDirectories: string[] = []

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { force: true, recursive: true })
    }
  })

  it('applies positive and negative Adjustments directly to an Asset Account balance', () => {
    const vaultPath = createVault()
    const account = createAccount(vaultPath, {
      name: 'Bank',
      nature: 'asset',
      currency: 'KRW',
    }).account

    const positive = recordAdjustment(vaultPath, {
      accountId: account.id,
      amountMinor: 100_000,
      occurredOn: '2026-07-27',
      memo: '  opening balance  ',
    })
    const negative = recordAdjustment(vaultPath, {
      accountId: account.id,
      amountMinor: -30_000,
      occurredOn: '2026-07-28',
    })

    expect(positive).toEqual({
      action: 'created',
      transaction: {
        id: 1,
        kind: 'adjustment',
        occurredOn: '2026-07-27',
        account: {
          id: account.id,
          name: 'Bank',
          nature: 'asset',
          currency: 'KRW',
          archived: false,
        },
        amountMinor: 100_000,
        memo: 'opening balance',
      },
      previousBalanceMinor: 0,
      adjustmentAmountMinor: 100_000,
      resultingBalanceMinor: 100_000,
      requestedTargetBalanceMinor: null,
    })
    expect(negative.previousBalanceMinor).toBe(100_000)
    expect(negative.adjustmentAmountMinor).toBe(-30_000)
    expect(negative.resultingBalanceMinor).toBe(70_000)
    expect(listAccounts(vaultPath)[0]?.balanceMinor).toBe(70_000)
  })

  it('applies signed Adjustments directly to a Liability Account balance', () => {
    const vaultPath = createVault()
    const account = createAccount(vaultPath, {
      name: 'Card',
      nature: 'liability',
      currency: 'USD',
    }).account

    const positive = recordAdjustment(vaultPath, {
      accountId: account.id,
      amountMinor: 5_000,
      occurredOn: '2026-07-27',
    })
    const negative = recordAdjustment(vaultPath, {
      accountId: account.id,
      amountMinor: -8_000,
      occurredOn: '2026-07-28',
    })

    expect(positive.resultingBalanceMinor).toBe(5_000)
    expect(negative.previousBalanceMinor).toBe(5_000)
    expect(negative.resultingBalanceMinor).toBe(-3_000)
  })

  it('calculates the necessary Adjustment from a requested target balance', () => {
    const vaultPath = createVault()
    const asset = createAccount(vaultPath, {
      name: 'Cash',
      nature: 'asset',
      currency: 'KRW',
    }).account
    const liability = createAccount(vaultPath, {
      name: 'Loan',
      nature: 'liability',
      currency: 'KRW',
    }).account
    recordAdjustment(vaultPath, {
      accountId: asset.id,
      amountMinor: 50_000,
      occurredOn: '2026-07-26',
    })
    recordAdjustment(vaultPath, {
      accountId: liability.id,
      amountMinor: -20_000,
      occurredOn: '2026-07-26',
    })

    const assetTarget = recordAdjustment(vaultPath, {
      accountId: asset.id,
      targetBalanceMinor: 125_000,
      occurredOn: '2026-07-27',
    })
    const liabilityTarget = recordAdjustment(vaultPath, {
      accountId: liability.id,
      targetBalanceMinor: -5_000,
      occurredOn: '2026-07-27',
    })

    expect(assetTarget).toMatchObject({
      previousBalanceMinor: 50_000,
      adjustmentAmountMinor: 75_000,
      resultingBalanceMinor: 125_000,
      requestedTargetBalanceMinor: 125_000,
    })
    expect(liabilityTarget).toMatchObject({
      previousBalanceMinor: -20_000,
      adjustmentAmountMinor: 15_000,
      resultingBalanceMinor: -5_000,
      requestedTargetBalanceMinor: -5_000,
    })
  })

  it('does not count Adjustments as Income, Expense, or categorizable Transactions', () => {
    const vaultPath = createVault()
    const account = createAccount(vaultPath, {
      name: 'Cash',
      nature: 'asset',
      currency: 'KRW',
    }).account
    const category = createCategory(vaultPath, { name: 'Food' }).category
    const adjustment = recordAdjustment(vaultPath, {
      accountId: account.id,
      amountMinor: 10_000,
      occurredOn: '2026-07-27',
    })
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
    expect(() =>
      setCategoryAssignments(vaultPath, adjustment.transaction.id, [
        { categoryId: category.id, amountMinor: 10_000, origin: 'explicit' },
      ]),
    ).toThrow(/Adjustment Transaction.*cannot receive Category Assignments/)
  })

  it('validates request shape and active Account use', () => {
    const vaultPath = createVault()
    const account = createAccount(vaultPath, {
      name: 'Closed',
      nature: 'asset',
      currency: 'KRW',
    }).account

    expect(() =>
      recordAdjustment(vaultPath, {
        accountId: account.id,
        occurredOn: '2026-07-27',
      }),
    ).toThrow(/exactly one/)
    expect(() =>
      recordAdjustment(vaultPath, {
        accountId: account.id,
        amountMinor: 1,
        targetBalanceMinor: 1,
        occurredOn: '2026-07-27',
      }),
    ).toThrow(/exactly one/)
    expect(() =>
      recordAdjustment(vaultPath, {
        accountId: account.id,
        amountMinor: 0,
        occurredOn: '2026-07-27',
      }),
    ).toThrow(/must be nonzero/)
    expect(() =>
      recordAdjustment(vaultPath, {
        accountId: account.id,
        targetBalanceMinor: 0,
        occurredOn: '2026-07-27',
      }),
    ).toThrow(/already has the requested balance/)

    archiveAccount(vaultPath, account.id)
    expect(() =>
      recordAdjustment(vaultPath, {
        accountId: account.id,
        amountMinor: 1,
        occurredOn: '2026-07-27',
      }),
    ).toThrow(/Archived Account.*cannot receive new Transactions/)
  })

  it('writes the Adjustment and its Change Record atomically', () => {
    const vaultPath = createVault()
    const account = createAccount(vaultPath, {
      name: 'Audited',
      nature: 'asset',
      currency: 'KRW',
    }).account
    const database = openDatabase(vaultPath)
    database.exec(`
      CREATE TRIGGER test_reject_adjustment_change
      BEFORE INSERT ON change_records
      WHEN NEW.entity_type = 'transaction'
      BEGIN
        SELECT RAISE(ABORT, 'forced Adjustment Change Record failure');
      END;
    `)
    database.close()

    expect(() =>
      recordAdjustment(vaultPath, {
        accountId: account.id,
        amountMinor: 10_000,
        occurredOn: '2026-07-27',
      }),
    ).toThrow(/forced Adjustment Change Record failure/)
    expect(listAccounts(vaultPath)[0]?.balanceMinor).toBe(0)

    const reopenedDatabase = openDatabase(vaultPath)
    reopenedDatabase.exec('DROP TRIGGER test_reject_adjustment_change')
    reopenedDatabase.close()
    const result = recordAdjustment(vaultPath, {
      accountId: account.id,
      amountMinor: 10_000,
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
    const parentPath = mkdtempSync(join(tmpdir(), 'fin-adjustment-test-'))
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
