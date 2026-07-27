import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createAccount,
  initializeVault,
  inspectTransactionRelations,
  listAccounts,
  recordIncomeExpense,
  recordRefund,
  recordTransfer,
  recordTransferFee,
} from './index.js'

describe('Refund and transfer fee operations', () => {
  const temporaryDirectories: string[] = []

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { force: true, recursive: true })
    }
  })

  it('records full and partial Refunds as negative Expenses that reduce Expense totals', () => {
    const vaultPath = createVault()
    const account = createAccount(vaultPath, {
      name: 'Bank',
      nature: 'asset',
      currency: 'KRW',
    }).account
    const firstExpense = recordIncomeExpense(vaultPath, {
      kind: 'expense',
      accountId: account.id,
      amountMinor: 100_000,
      occurredOn: '2026-07-25',
      memo: 'first purchase',
    }).transaction
    const secondExpense = recordIncomeExpense(vaultPath, {
      kind: 'expense',
      accountId: account.id,
      amountMinor: 80_000,
      occurredOn: '2026-07-25',
      memo: 'second purchase',
    }).transaction

    const full = recordRefund(vaultPath, {
      accountId: account.id,
      amountMinor: 100_000,
      occurredOn: '2026-07-26',
      memo: 'full refund',
      originalExpenseId: firstExpense.id,
    })
    const partial = recordRefund(vaultPath, {
      accountId: account.id,
      amountMinor: 30_000,
      occurredOn: '2026-07-27',
      memo: 'partial refund',
      originalExpenseId: secondExpense.id,
    })
    const database = openDatabase(vaultPath)
    const expenseTotal = database
      .prepare(
        `SELECT sum(amount_minor) AS total
         FROM transactions
         WHERE kind = 'expense'`,
      )
      .get() as { total: number }
    database.close()

    expect(full.transaction.amountMinor).toBe(-100_000)
    expect(full.relation).toEqual({
      kind: 'refund_of',
      targetTransactionId: firstExpense.id,
    })
    expect(full.previousBalanceMinor).toBe(-180_000)
    expect(full.resultingBalanceMinor).toBe(-80_000)
    expect(partial.transaction.amountMinor).toBe(-30_000)
    expect(partial.resultingBalanceMinor).toBe(-50_000)
    expect(expenseTotal.total).toBe(50_000)
    expect(listAccounts(vaultPath)[0]?.balanceMinor).toBe(-50_000)
  })

  it('records an unlinked Refund and keeps a linked Refund after its original is deleted', () => {
    const vaultPath = createVault()
    const account = createAccount(vaultPath, {
      name: 'Card',
      nature: 'liability',
      currency: 'KRW',
    }).account
    const original = recordIncomeExpense(vaultPath, {
      kind: 'expense',
      accountId: account.id,
      amountMinor: 50_000,
      occurredOn: '2026-07-25',
    }).transaction
    const linked = recordRefund(vaultPath, {
      accountId: account.id,
      amountMinor: 20_000,
      occurredOn: '2026-07-26',
      originalExpenseId: original.id,
    })
    const unlinked = recordRefund(vaultPath, {
      accountId: account.id,
      amountMinor: 5_000,
      occurredOn: '2026-07-27',
    })

    expect(unlinked.relation).toBeNull()

    const database = openDatabase(vaultPath)
    database.prepare('DELETE FROM transactions WHERE id = ?').run(original.id)
    const linkedRefundCount = database
      .prepare('SELECT count(*) AS count FROM transactions WHERE id = ?')
      .get(linked.transaction.id) as { count: number }
    const relationCount = database
      .prepare('SELECT count(*) AS count FROM transaction_relations')
      .get() as { count: number }
    database.close()

    expect(linkedRefundCount.count).toBe(1)
    expect(relationCount.count).toBe(0)
    expect(inspectTransactionRelations(vaultPath, linked.transaction.id)).toMatchObject({
      relatedTransactions: [],
      requiresConfirmationBeforeMultiTransactionChange: false,
    })
  })

  it('records a transfer fee as a positive Expense related to a Transfer', () => {
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
    const transfer = recordTransfer(vaultPath, {
      sourceAccountId: source.id,
      sourceAmountMinor: 100_000,
      destinationAccountId: destination.id,
      destinationAmountMinor: 100_000,
      occurredOn: '2026-07-26',
    }).transaction

    const fee = recordTransferFee(vaultPath, {
      accountId: source.id,
      amountMinor: 1_500,
      occurredOn: '2026-07-26',
      memo: 'wire fee',
      transferId: transfer.id,
    })
    const inspection = inspectTransactionRelations(vaultPath, transfer.id)

    expect(fee.transaction.kind).toBe('expense')
    expect(fee.transaction.amountMinor).toBe(1_500)
    expect(fee.relation).toEqual({
      kind: 'fee_for',
      targetTransactionId: transfer.id,
    })
    expect(inspection).toEqual({
      transaction: {
        id: transfer.id,
        kind: 'transfer',
        occurredOn: '2026-07-26',
        memo: null,
        accountId: null,
        amountMinor: null,
        sourceAccountId: source.id,
        sourceAmountMinor: 100_000,
        destinationAccountId: destination.id,
        destinationAmountMinor: 100_000,
      },
      relatedTransactions: [
        {
          relationKind: 'fee_for',
          direction: 'incoming',
          transaction: {
            id: fee.transaction.id,
            kind: 'expense',
            occurredOn: '2026-07-26',
            memo: 'wire fee',
            accountId: source.id,
            amountMinor: 1_500,
            sourceAccountId: null,
            sourceAmountMinor: null,
            destinationAccountId: null,
            destinationAmountMinor: null,
          },
        },
      ],
      requiresConfirmationBeforeMultiTransactionChange: true,
    })
  })

  it('never silently mutates the other side of a relation', () => {
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
    const transfer = recordTransfer(vaultPath, {
      sourceAccountId: source.id,
      sourceAmountMinor: 1_000,
      destinationAccountId: destination.id,
      destinationAmountMinor: 1_000,
      occurredOn: '2026-07-26',
      memo: 'original transfer',
    }).transaction
    const fee = recordTransferFee(vaultPath, {
      accountId: source.id,
      amountMinor: 100,
      occurredOn: '2026-07-26',
      memo: 'original fee',
      transferId: transfer.id,
    }).transaction
    const database = openDatabase(vaultPath)
    database.prepare('UPDATE transactions SET memo = ? WHERE id = ?').run('edited fee', fee.id)
    const transferMemo = database
      .prepare('SELECT memo FROM transactions WHERE id = ?')
      .get(transfer.id) as { memo: string | null }
    database.prepare('DELETE FROM transactions WHERE id = ?').run(fee.id)
    const transferCount = database
      .prepare('SELECT count(*) AS count FROM transactions WHERE id = ?')
      .get(transfer.id) as { count: number }
    database.close()

    expect(transferMemo.memo).toBe('original transfer')
    expect(transferCount.count).toBe(1)
  })

  it('rejects missing or invalid relation targets without writing a Transaction', () => {
    const vaultPath = createVault()
    const account = createAccount(vaultPath, {
      name: 'Cash',
      nature: 'asset',
      currency: 'KRW',
    }).account
    const income = recordIncomeExpense(vaultPath, {
      kind: 'income',
      accountId: account.id,
      amountMinor: 10_000,
      occurredOn: '2026-07-25',
    }).transaction

    expect(() =>
      recordRefund(vaultPath, {
        accountId: account.id,
        amountMinor: 1_000,
        occurredOn: '2026-07-27',
        originalExpenseId: 999,
      }),
    ).toThrow(/Related positive Expense 999 is missing/)
    expect(() =>
      recordRefund(vaultPath, {
        accountId: account.id,
        amountMinor: 1_000,
        occurredOn: '2026-07-27',
        originalExpenseId: income.id,
      }),
    ).toThrow(/not the required positive Expense/)
    expect(() =>
      recordTransferFee(vaultPath, {
        accountId: account.id,
        amountMinor: 1_000,
        occurredOn: '2026-07-27',
        transferId: income.id,
      }),
    ).toThrow(/not the required Transfer/)

    const database = openDatabase(vaultPath)
    const transactionCount = database
      .prepare('SELECT count(*) AS count FROM transactions')
      .get() as { count: number }
    database.close()
    expect(transactionCount.count).toBe(1)
  })

  it('writes the related Expense and relation in one atomic Transaction Change Record', () => {
    const vaultPath = createVault()
    const account = createAccount(vaultPath, {
      name: 'Bank',
      nature: 'asset',
      currency: 'KRW',
    }).account
    const original = recordIncomeExpense(vaultPath, {
      kind: 'expense',
      accountId: account.id,
      amountMinor: 10_000,
      occurredOn: '2026-07-25',
    }).transaction
    const database = openDatabase(vaultPath)
    database.exec(`
      CREATE TRIGGER test_reject_related_expense_change
      BEFORE INSERT ON change_records
      WHEN NEW.entity_type = 'transaction' AND NEW.action = 'created'
      BEGIN
        SELECT RAISE(ABORT, 'forced related Expense Change Record failure');
      END;
    `)
    database.close()

    expect(() =>
      recordRefund(vaultPath, {
        accountId: account.id,
        amountMinor: 5_000,
        occurredOn: '2026-07-27',
        originalExpenseId: original.id,
      }),
    ).toThrow(/forced related Expense Change Record failure/)

    const failedDatabase = openDatabase(vaultPath)
    const failedCounts = failedDatabase
      .prepare(
        `SELECT
           (SELECT count(*) FROM transactions) AS transaction_count,
           (SELECT count(*) FROM transaction_relations) AS relation_count`,
      )
      .get() as { transaction_count: number; relation_count: number }
    failedDatabase.exec('DROP TRIGGER test_reject_related_expense_change')
    failedDatabase.close()

    expect(failedCounts).toEqual({ transaction_count: 1, relation_count: 0 })

    const result = recordRefund(vaultPath, {
      accountId: account.id,
      amountMinor: 5_000,
      occurredOn: '2026-07-27',
      originalExpenseId: original.id,
    })
    const finalDatabase = openDatabase(vaultPath)
    const record = finalDatabase
      .prepare(
        `SELECT payload
         FROM change_records
         WHERE entity_type = 'transaction' AND entity_id = ?`,
      )
      .get(String(result.transaction.id)) as { payload: string }
    const relationCount = finalDatabase
      .prepare('SELECT count(*) AS count FROM transaction_relations')
      .get() as { count: number }
    finalDatabase.close()

    expect(JSON.parse(record.payload)).toEqual(result)
    expect(relationCount.count).toBe(1)
  })

  function createVault(): string {
    const parentPath = mkdtempSync(join(tmpdir(), 'fin-related-expense-test-'))
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
