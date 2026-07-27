import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  archiveAccount,
  createAccount,
  getIncomeExpenseTransaction,
  initializeVault,
  listAccounts,
  listIncomeExpenseTransactions,
  recordIncomeExpense,
} from './index.js'

describe('Income and Expense operations', () => {
  const temporaryDirectories: string[] = []

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { force: true, recursive: true })
    }
  })

  it('records Income and Expense against an Asset Account with immediate balances', () => {
    const vaultPath = createVault()
    const account = createAccount(vaultPath, {
      name: 'Bank',
      nature: 'asset',
      currency: 'KRW',
    }).account

    const income = recordIncomeExpense(vaultPath, {
      kind: 'income',
      accountId: account.id,
      amountMinor: 250_000,
      occurredOn: '2026-07-26',
      memo: '  salary  ',
    })
    const expense = recordIncomeExpense(vaultPath, {
      kind: 'expense',
      accountId: account.id,
      amountMinor: 30_000,
      occurredOn: '2026-07-27',
      memo: 'groceries',
    })

    expect(income).toEqual({
      action: 'created',
      transaction: {
        id: 1,
        kind: 'income',
        occurredOn: '2026-07-26',
        account: {
          id: account.id,
          name: 'Bank',
          nature: 'asset',
          currency: 'KRW',
          archived: false,
        },
        amountMinor: 250_000,
        memo: 'salary',
      },
      previousBalanceMinor: 0,
      resultingBalanceMinor: 250_000,
    })
    expect(expense.previousBalanceMinor).toBe(250_000)
    expect(expense.resultingBalanceMinor).toBe(220_000)
    expect(listAccounts(vaultPath)[0]?.balanceMinor).toBe(220_000)
  })

  it('applies Income and Expense in the correct direction for a Liability Account', () => {
    const vaultPath = createVault()
    const account = createAccount(vaultPath, {
      name: 'Card',
      nature: 'liability',
      currency: 'KRW',
    }).account

    const income = recordIncomeExpense(vaultPath, {
      kind: 'income',
      accountId: account.id,
      amountMinor: 100_000,
      occurredOn: '2026-07-26',
    })
    const expense = recordIncomeExpense(vaultPath, {
      kind: 'expense',
      accountId: account.id,
      amountMinor: 30_000,
      occurredOn: '2026-07-27',
    })

    expect(income.resultingBalanceMinor).toBe(-100_000)
    expect(expense.previousBalanceMinor).toBe(-100_000)
    expect(expense.resultingBalanceMinor).toBe(-70_000)
    expect(listAccounts(vaultPath)[0]?.balanceMinor).toBe(-70_000)
  })

  it('lists and inspects Transactions with every material value', () => {
    const vaultPath = createVault()
    const account = createAccount(vaultPath, {
      name: 'Cash',
      nature: 'asset',
      currency: 'USD',
    }).account
    const first = recordIncomeExpense(vaultPath, {
      kind: 'expense',
      accountId: account.id,
      amountMinor: 1_250,
      occurredOn: '2026-07-25',
      memo: null,
    }).transaction
    const second = recordIncomeExpense(vaultPath, {
      kind: 'income',
      accountId: account.id,
      amountMinor: 5_000,
      occurredOn: '2026-07-27',
      memo: 'rebate',
    }).transaction

    expect(listIncomeExpenseTransactions(vaultPath)).toEqual([second, first])
    expect(getIncomeExpenseTransaction(vaultPath, first.id)).toEqual(first)
  })

  it('requires positive integer amounts and valid calendar dates', () => {
    const vaultPath = createVault()
    const account = createAccount(vaultPath, {
      name: 'Cash',
      nature: 'asset',
      currency: 'KRW',
    }).account

    for (const amountMinor of [0, -1, 1.5]) {
      expect(() =>
        recordIncomeExpense(vaultPath, {
          kind: 'expense',
          accountId: account.id,
          amountMinor,
          occurredOn: '2026-07-27',
        }),
      ).toThrow(/amounts must be positive integer minor units/)
    }

    expect(() =>
      recordIncomeExpense(vaultPath, {
        kind: 'income',
        accountId: account.id,
        amountMinor: 1,
        occurredOn: '2026-02-30',
      }),
    ).toThrow(/not a valid calendar date/)
    expect(
      recordIncomeExpense(vaultPath, {
        kind: 'income',
        accountId: account.id,
        amountMinor: 1,
        occurredOn: '2026-02-28',
        memo: '   ',
      }).transaction.memo,
    ).toBeNull()
  })

  it('rejects Transactions against an archived Account', () => {
    const vaultPath = createVault()
    const account = createAccount(vaultPath, {
      name: 'Closed',
      nature: 'asset',
      currency: 'KRW',
    }).account
    archiveAccount(vaultPath, account.id)

    expect(() =>
      recordIncomeExpense(vaultPath, {
        kind: 'expense',
        accountId: account.id,
        amountMinor: 1_000,
        occurredOn: '2026-07-27',
      }),
    ).toThrow(/Archived Account 1.*cannot receive new Transactions/)
  })

  it('writes the Transaction and its immutable Change Record atomically', () => {
    const vaultPath = createVault()
    const account = createAccount(vaultPath, {
      name: 'Bank',
      nature: 'asset',
      currency: 'KRW',
    }).account
    const database = openDatabase(vaultPath)
    database.exec(`
      CREATE TRIGGER test_reject_transaction_change
      BEFORE INSERT ON change_records
      WHEN NEW.entity_type = 'transaction'
      BEGIN
        SELECT RAISE(ABORT, 'forced Transaction Change Record failure');
      END;
    `)
    database.close()

    expect(() =>
      recordIncomeExpense(vaultPath, {
        kind: 'income',
        accountId: account.id,
        amountMinor: 10_000,
        occurredOn: '2026-07-27',
      }),
    ).toThrow(/forced Transaction Change Record failure/)
    expect(listIncomeExpenseTransactions(vaultPath)).toEqual([])
    expect(listAccounts(vaultPath)[0]?.balanceMinor).toBe(0)

    const reopenedDatabase = openDatabase(vaultPath)
    reopenedDatabase.exec('DROP TRIGGER test_reject_transaction_change')
    reopenedDatabase.close()
    const recorded = recordIncomeExpense(vaultPath, {
      kind: 'income',
      accountId: account.id,
      amountMinor: 10_000,
      occurredOn: '2026-07-27',
      memo: 'bonus',
    })
    const finalDatabase = openDatabase(vaultPath)
    const changeRecord = finalDatabase
      .prepare(
        `SELECT payload
         FROM change_records
         WHERE entity_type = 'transaction' AND entity_id = ?`,
      )
      .get(String(recorded.transaction.id)) as { payload: string }

    expect(JSON.parse(changeRecord.payload)).toEqual(recorded)
    expect(() =>
      finalDatabase
        .prepare('UPDATE change_records SET payload = json(?) WHERE entity_type = ?')
        .run('{"changed":true}', 'transaction'),
    ).toThrow(/change records are immutable/)
    finalDatabase.close()
  })

  function createVault(): string {
    const parentPath = mkdtempSync(join(tmpdir(), 'fin-income-expense-test-'))
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
