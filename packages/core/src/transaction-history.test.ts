import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createAccount,
  createCategory,
  deleteTransaction,
  editTransaction,
  getIncomeExpenseTransaction,
  initializeVault,
  listAccounts,
  listTransactionChangeRecords,
  recordAdjustment,
  recordIncomeExpense,
  recordRefund,
  recordTransfer,
  recordTransferFee,
  recreateTransaction,
  setCategoryAssignments,
} from './index.js'

describe('Transaction lifecycle and Change Record history', () => {
  const temporaryDirectories: string[] = []

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { force: true, recursive: true })
    }
  })

  it('edits, deletes, describes, and recreates Income with a new identity', () => {
    const vaultPath = createVault()
    const bank = createAssetAccount(vaultPath, 'Bank')
    const income = recordIncomeExpense(vaultPath, {
      kind: 'income',
      accountId: bank.id,
      amountMinor: 100_000,
      occurredOn: '2026-07-20',
      memo: 'salary estimate',
    }).transaction

    const edited = editTransaction(vaultPath, {
      transactionId: income.id,
      replacement: {
        kind: 'income',
        accountId: bank.id,
        amountMinor: 120_000,
        occurredOn: '2026-07-21',
        memo: 'salary final',
      },
    })

    expect(edited.previousTransaction).toMatchObject({
      id: income.id,
      kind: 'income',
      amountMinor: 100_000,
    })
    expect(edited.transaction).toMatchObject({
      id: income.id,
      kind: 'income',
      amountMinor: 120_000,
      occurredOn: '2026-07-21',
      memo: 'salary final',
    })
    expect(edited.balanceChanges).toEqual([
      {
        accountId: bank.id,
        currency: 'KRW',
        previousBalanceMinor: 100_000,
        resultingBalanceMinor: 120_000,
      },
    ])

    const deleted = deleteTransaction(vaultPath, income.id)
    expect(deleted.balanceChanges[0]?.resultingBalanceMinor).toBe(0)
    expect(() => getIncomeExpenseTransaction(vaultPath, income.id)).toThrow(/does not exist/)
    const deletion = findDeletionRecord(vaultPath, income.id)
    expect(deletion.description).toContain('Deleted Income Transaction')
    expect(deletion.description).toContain('salary final')
    expect(deletion.description).toContain('120000 KRW')

    const recreated = recreateTransaction(vaultPath, deletion.id)
    expect(recreated.transaction).toMatchObject({
      kind: 'income',
      amountMinor: 120_000,
      occurredOn: '2026-07-21',
      memo: 'salary final',
    })
    expect(recreated.transaction.id).not.toBe(income.id)
    expect(recreated.deletedTransactionId).toBe(income.id)
    expect(listAccounts(vaultPath)[0]?.balanceMinor).toBe(120_000)

    const oldHistory = listTransactionChangeRecords(vaultPath, income.id)
    const newHistory = listTransactionChangeRecords(vaultPath, recreated.transaction.id)
    expect(oldHistory.map((record) => record.action)).toEqual(['created', 'updated', 'deleted'])
    expect(oldHistory[1]?.description).toContain('Edited Transaction 1 from Income Transaction 1')
    expect(newHistory).toHaveLength(1)
    expect(newHistory[0]?.description).toContain(`Recreated deleted Transaction ${income.id}`)
    expect(newHistory[0]?.description).toContain(`from Change Record ${deletion.id}`)
  })

  it('edits and recreates an Expense with Category Assignments and its outgoing relation', () => {
    const vaultPath = createVault()
    const bank = createAssetAccount(vaultPath, 'Bank')
    const clearing = createAssetAccount(vaultPath, 'Clearing')
    const fees = createCategory(vaultPath, {
      name: 'Fees',
    }).category
    const transfer = recordTransfer(vaultPath, {
      sourceAccountId: bank.id,
      sourceAmountMinor: 10_000,
      destinationAccountId: clearing.id,
      destinationAmountMinor: 10_000,
      occurredOn: '2026-07-20',
      memo: 'settlement',
    }).transaction
    const fee = recordTransferFee(vaultPath, {
      accountId: bank.id,
      amountMinor: 500,
      occurredOn: '2026-07-20',
      memo: 'estimated fee',
      transferId: transfer.id,
    }).transaction
    setCategoryAssignments(vaultPath, fee.id, [
      {
        categoryId: fees.id,
        amountMinor: 400,
        origin: 'inferred',
      },
    ])

    const edited = editTransaction(vaultPath, {
      transactionId: fee.id,
      replacement: {
        kind: 'expense',
        accountId: bank.id,
        amountMinor: 600,
        occurredOn: '2026-07-21',
        memo: 'final fee',
        assignments: [
          {
            categoryId: fees.id,
            amountMinor: 600,
            origin: 'explicit',
          },
        ],
      },
    })

    expect(edited.transaction).toMatchObject({
      kind: 'expense',
      amountMinor: 600,
      assignments: [
        {
          categoryId: fees.id,
          categoryPath: 'Fees',
          amountMinor: 600,
          origin: 'explicit',
        },
      ],
      relations: [
        {
          relationKind: 'fee_for',
          direction: 'outgoing',
          relatedTransaction: { id: transfer.id, kind: 'transfer' },
        },
      ],
    })
    expect(edited.requiresConfirmationBeforeMultiTransactionChange).toBe(true)
    expect(edited.balanceChanges[0]?.resultingBalanceMinor).toBe(-10_600)
    const renderedHistory = listTransactionChangeRecords(vaultPath, fee.id)
    expect(renderedHistory[0]?.description).toContain(
      `fee_for relation to Transaction ${transfer.id}`,
    )
    expect(renderedHistory[0]?.description).toContain('Account balance -10000 to -10500')
    expect(renderedHistory[1]?.description).toContain('previous Category Assignments: none')
    expect(renderedHistory[1]?.description).toContain(
      'applied Category Assignments: inferred Category "Fees" 400 KRW',
    )
    expect(renderedHistory[1]?.description).toContain('uncategorized remainder 100')

    deleteTransaction(vaultPath, fee.id)
    expect(readCount(vaultPath, 'transaction_relations')).toBe(0)
    expect(readCount(vaultPath, 'category_assignments')).toBe(0)
    expect(transactionExists(vaultPath, transfer.id)).toBe(true)

    const deletion = findDeletionRecord(vaultPath, fee.id)
    expect(deletion.description).toContain('explicit Category "Fees" 600 KRW')
    expect(deletion.description).toContain(`outgoing fee_for Transaction ${transfer.id}`)

    const recreated = recreateTransaction(vaultPath, deletion.id)
    expect(recreated.transaction.id).not.toBe(fee.id)
    expect(recreated.transaction).toMatchObject({
      kind: 'expense',
      amountMinor: 600,
      assignments: [
        {
          categoryId: fees.id,
          categoryPath: 'Fees',
          amountMinor: 600,
          origin: 'explicit',
        },
      ],
      relations: [
        {
          relationKind: 'fee_for',
          direction: 'outgoing',
          relatedTransaction: { id: transfer.id },
        },
      ],
    })
    expect(readCount(vaultPath, 'transaction_relations')).toBe(1)
    expect(readCount(vaultPath, 'category_assignments')).toBe(1)
    expect(transactionExists(vaultPath, transfer.id)).toBe(true)
  })

  it('edits, deletes, describes, and recreates an Adjustment', () => {
    const vaultPath = createVault()
    const cash = createAssetAccount(vaultPath, 'Cash')
    const adjustment = recordAdjustment(vaultPath, {
      accountId: cash.id,
      occurredOn: '2026-07-20',
      amountMinor: 2_000,
      memo: 'opening correction',
    }).transaction

    const edited = editTransaction(vaultPath, {
      transactionId: adjustment.id,
      replacement: {
        kind: 'adjustment',
        accountId: cash.id,
        amountMinor: -500,
        occurredOn: '2026-07-21',
        memo: 'final correction',
      },
    })

    expect(edited.transaction).toMatchObject({
      kind: 'adjustment',
      amountMinor: -500,
      occurredOn: '2026-07-21',
      memo: 'final correction',
    })
    expect(edited.balanceChanges[0]).toMatchObject({
      previousBalanceMinor: 2_000,
      resultingBalanceMinor: -500,
    })

    deleteTransaction(vaultPath, adjustment.id)
    const deletion = findDeletionRecord(vaultPath, adjustment.id)
    expect(deletion.description).toContain('Deleted Adjustment Transaction')
    expect(deletion.description).toContain('-500 KRW')
    const recreated = recreateTransaction(vaultPath, deletion.id)

    expect(recreated.transaction).toMatchObject({
      kind: 'adjustment',
      amountMinor: -500,
      occurredOn: '2026-07-21',
      memo: 'final correction',
    })
    expect(recreated.transaction.id).not.toBe(adjustment.id)
    expect(listAccounts(vaultPath)[0]?.balanceMinor).toBe(-500)
  })

  it('edits, deletes, describes, and recreates both sides of a Transfer', () => {
    const vaultPath = createVault()
    const source = createAssetAccount(vaultPath, 'Source')
    const destination = createAssetAccount(vaultPath, 'Destination')
    const transfer = recordTransfer(vaultPath, {
      sourceAccountId: source.id,
      sourceAmountMinor: 10_000,
      destinationAccountId: destination.id,
      destinationAmountMinor: 10_000,
      occurredOn: '2026-07-20',
      memo: 'draft move',
    }).transaction

    const edited = editTransaction(vaultPath, {
      transactionId: transfer.id,
      replacement: {
        kind: 'transfer',
        sourceAccountId: source.id,
        sourceAmountMinor: 12_000,
        destinationAccountId: destination.id,
        destinationAmountMinor: 12_000,
        occurredOn: '2026-07-21',
        memo: 'final move',
      },
    })

    expect(edited.transaction).toMatchObject({
      kind: 'transfer',
      occurredOn: '2026-07-21',
      source: { account: { id: source.id }, amountMinor: 12_000 },
      destination: {
        account: { id: destination.id },
        amountMinor: 12_000,
      },
      memo: 'final move',
    })
    expect(edited.balanceChanges).toEqual([
      {
        accountId: source.id,
        currency: 'KRW',
        previousBalanceMinor: -10_000,
        resultingBalanceMinor: -12_000,
      },
      {
        accountId: destination.id,
        currency: 'KRW',
        previousBalanceMinor: 10_000,
        resultingBalanceMinor: 12_000,
      },
    ])

    deleteTransaction(vaultPath, transfer.id)
    expect(listAccounts(vaultPath).map((account) => account.balanceMinor)).toEqual([0, 0])
    const deletion = findDeletionRecord(vaultPath, transfer.id)
    expect(deletion.description).toContain('Deleted Transfer Transaction')
    expect(deletion.description).toContain('source Account')
    expect(deletion.description).toContain('destination Account')
    const recreated = recreateTransaction(vaultPath, deletion.id)

    expect(recreated.transaction).toMatchObject({
      kind: 'transfer',
      source: { account: { id: source.id }, amountMinor: 12_000 },
      destination: {
        account: { id: destination.id },
        amountMinor: 12_000,
      },
    })
    expect(recreated.transaction.id).not.toBe(transfer.id)
    expect(listAccounts(vaultPath).map((account) => account.balanceMinor)).toEqual([
      -12_000, 12_000,
    ])
  })

  it('identifies incoming relations and never reattaches them implicitly', () => {
    const vaultPath = createVault()
    const bank = createAssetAccount(vaultPath, 'Bank')
    const original = recordIncomeExpense(vaultPath, {
      kind: 'expense',
      accountId: bank.id,
      amountMinor: 5_000,
      occurredOn: '2026-07-20',
      memo: 'purchase',
    }).transaction
    const refund = recordRefund(vaultPath, {
      accountId: bank.id,
      amountMinor: 2_000,
      occurredOn: '2026-07-21',
      memo: 'partial return',
      originalExpenseId: original.id,
    }).transaction

    const deleted = deleteTransaction(vaultPath, original.id)

    expect(deleted.relatedTransactions).toEqual([
      {
        relationKind: 'refund_of',
        direction: 'incoming',
        relatedTransaction: {
          id: refund.id,
          kind: 'expense',
          occurredOn: '2026-07-21',
          memo: 'partial return',
        },
      },
    ])
    expect(deleted.requiresConfirmationBeforeMultiTransactionChange).toBe(true)
    expect(transactionExists(vaultPath, refund.id)).toBe(true)
    expect(readCount(vaultPath, 'transaction_relations')).toBe(0)

    const recreated = recreateTransaction(vaultPath, findDeletionRecord(vaultPath, original.id).id)
    expect(recreated.omittedIncomingRelations).toEqual(deleted.relatedTransactions)
    expect(transactionExists(vaultPath, refund.id)).toBe(true)
    expect(readCount(vaultPath, 'transaction_relations')).toBe(0)
  })

  it('rolls back edits, deletions, and recreation when their Change Record cannot be written', () => {
    const vaultPath = createVault()
    const cash = createAssetAccount(vaultPath, 'Cash')
    const adjustment = recordAdjustment(vaultPath, {
      accountId: cash.id,
      occurredOn: '2026-07-20',
      amountMinor: 1_000,
    }).transaction
    const database = openDatabase(vaultPath)
    database.exec(`
      CREATE TRIGGER reject_transaction_change_record
      BEFORE INSERT ON change_records
      WHEN NEW.entity_type = 'transaction'
      BEGIN
        SELECT RAISE(ABORT, 'forced Transaction Change Record failure');
      END;
    `)
    database.close()

    expect(() =>
      editTransaction(vaultPath, {
        transactionId: adjustment.id,
        replacement: {
          kind: 'adjustment',
          accountId: cash.id,
          amountMinor: 2_000,
          occurredOn: '2026-07-21',
        },
      }),
    ).toThrow(/forced Transaction Change Record failure/)
    expect(() => deleteTransaction(vaultPath, adjustment.id)).toThrow(
      /forced Transaction Change Record failure/,
    )
    expect(readTransactionAmount(vaultPath, adjustment.id)).toBe(1_000)
    expect(listAccounts(vaultPath)[0]?.balanceMinor).toBe(1_000)
    expect(listTransactionChangeRecords(vaultPath, adjustment.id)).toHaveLength(1)

    const writableDatabase = openDatabase(vaultPath)
    writableDatabase.exec('DROP TRIGGER reject_transaction_change_record')
    writableDatabase.close()
    deleteTransaction(vaultPath, adjustment.id)
    const deletion = findDeletionRecord(vaultPath, adjustment.id)
    const failingDatabase = openDatabase(vaultPath)
    failingDatabase.exec(`
      CREATE TRIGGER reject_transaction_change_record
      BEFORE INSERT ON change_records
      WHEN NEW.entity_type = 'transaction'
      BEGIN
        SELECT RAISE(ABORT, 'forced Transaction Change Record failure');
      END;
    `)
    failingDatabase.close()

    expect(() => recreateTransaction(vaultPath, deletion.id)).toThrow(
      /forced Transaction Change Record failure/,
    )
    expect(readCount(vaultPath, 'transactions')).toBe(0)
    expect(listAccounts(vaultPath)[0]?.balanceMinor).toBe(0)
  })

  function createVault(): string {
    const vaultPath = mkdtempSync(join(tmpdir(), 'fin-transaction-history-'))
    temporaryDirectories.push(vaultPath)
    initializeVault(vaultPath)
    return vaultPath
  }
})

function createAssetAccount(vaultPath: string, name: string) {
  return createAccount(vaultPath, {
    name,
    nature: 'asset',
    currency: 'KRW',
  }).account
}

function findDeletionRecord(vaultPath: string, transactionId: number) {
  const record = listTransactionChangeRecords(vaultPath, transactionId).find(
    (candidate) => candidate.action === 'deleted',
  )

  if (!record) {
    throw new Error(`Deletion Change Record for Transaction ${transactionId} is missing`)
  }

  return record
}

function openDatabase(vaultPath: string): DatabaseSync {
  const database = new DatabaseSync(join(vaultPath, 'fin.sqlite'))
  database.exec('PRAGMA foreign_keys = ON')
  return database
}

function transactionExists(vaultPath: string, transactionId: number): boolean {
  const database = openDatabase(vaultPath)
  const row = database
    .prepare('SELECT count(*) AS count FROM transactions WHERE id = ?')
    .get(transactionId) as { count: number }
  database.close()
  return row.count === 1
}

function readCount(
  vaultPath: string,
  table: 'transactions' | 'category_assignments' | 'transaction_relations',
): number {
  const database = openDatabase(vaultPath)
  const row = database.prepare(`SELECT count(*) AS count FROM ${table}`).get() as {
    count: number
  }
  database.close()
  return row.count
}

function readTransactionAmount(vaultPath: string, transactionId: number): number {
  const database = openDatabase(vaultPath)
  const row = database
    .prepare('SELECT amount_minor FROM transactions WHERE id = ?')
    .get(transactionId) as { amount_minor: number }
  database.close()
  return row.amount_minor
}
