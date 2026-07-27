import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  archiveCategory,
  createAccount,
  createCategory,
  getTransactionClassification,
  initializeVault,
  recordIncomeExpense,
  setCategoryAssignments,
} from './index.js'

describe('Category Assignment operations', () => {
  const temporaryDirectories: string[] = []

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { force: true, recursive: true })
    }
  })

  it('classifies a full Transaction across active Categories at every hierarchy level', () => {
    const vaultPath = createVault()
    const account = createAccount(vaultPath, {
      name: 'Cash',
      nature: 'asset',
      currency: 'KRW',
    }).account
    const living = createCategory(vaultPath, { name: 'Living' }).category
    const food = createCategory(vaultPath, { name: 'Food', parentId: living.id }).category
    const groceries = createCategory(vaultPath, {
      name: 'Groceries',
      parentId: food.id,
    }).category
    const transaction = recordIncomeExpense(vaultPath, {
      kind: 'expense',
      accountId: account.id,
      amountMinor: 60_000,
      occurredOn: '2026-07-27',
    }).transaction

    const result = setCategoryAssignments(vaultPath, transaction.id, [
      { categoryId: living.id, amountMinor: 10_000, origin: 'explicit' },
      { categoryId: food.id, amountMinor: 20_000, origin: 'inferred' },
      { categoryId: groceries.id, amountMinor: 30_000, origin: 'explicit' },
    ])

    expect(result.transaction).toEqual(transaction)
    expect(result.previousAssignments).toEqual([])
    expect(
      result.assignments.map(({ category, amountMinor, origin, currency }) => ({
        path: category.path,
        amountMinor,
        origin,
        currency,
      })),
    ).toEqual([
      { path: 'Living', amountMinor: 10_000, origin: 'explicit', currency: 'KRW' },
      { path: 'Living > Food', amountMinor: 20_000, origin: 'inferred', currency: 'KRW' },
      {
        path: 'Living > Food > Groceries',
        amountMinor: 30_000,
        origin: 'explicit',
        currency: 'KRW',
      },
    ])
    expect(result.uncategorizedAmountMinor).toBe(0)
  })

  it('reports an inferred partial Assignment and signed uncategorized remainder', () => {
    const fixture = createPositiveFixture()

    const result = setCategoryAssignments(fixture.vaultPath, fixture.transactionId, [
      {
        categoryId: fixture.categoryId,
        amountMinor: 35_000,
        origin: 'inferred',
      },
    ])
    const inspected = getTransactionClassification(fixture.vaultPath, fixture.transactionId)

    expect(result.assignments[0]).toMatchObject({
      category: {
        id: fixture.categoryId,
        path: 'Living > Food',
      },
      amountMinor: 35_000,
      origin: 'inferred',
      currency: 'KRW',
    })
    expect(result.uncategorizedAmountMinor).toBe(65_000)
    expect(inspected).toEqual({
      transaction: result.transaction,
      assignments: result.assignments,
      uncategorizedAmountMinor: 65_000,
    })
  })

  it('replaces and clears split Assignments while returning the previous set', () => {
    const fixture = createPositiveFixture()
    const otherCategory = createCategory(fixture.vaultPath, { name: 'Other' }).category
    const first = setCategoryAssignments(fixture.vaultPath, fixture.transactionId, [
      { categoryId: fixture.categoryId, amountMinor: 40_000, origin: 'explicit' },
      { categoryId: otherCategory.id, amountMinor: 20_000, origin: 'explicit' },
    ])
    const replaced = setCategoryAssignments(fixture.vaultPath, fixture.transactionId, [
      { categoryId: otherCategory.id, amountMinor: 75_000, origin: 'inferred' },
    ])
    const cleared = setCategoryAssignments(fixture.vaultPath, fixture.transactionId, [])

    expect(replaced.previousAssignments).toEqual(first.assignments)
    expect(replaced.assignments).toHaveLength(1)
    expect(replaced.uncategorizedAmountMinor).toBe(25_000)
    expect(cleared.previousAssignments).toEqual(replaced.assignments)
    expect(cleared.assignments).toEqual([])
    expect(cleared.uncategorizedAmountMinor).toBe(100_000)
  })

  it('supports negative Expense Assignments with negative remainder', () => {
    const vaultPath = createVault()
    const account = createAccount(vaultPath, {
      name: 'Card',
      nature: 'liability',
      currency: 'USD',
    }).account
    const refunds = createCategory(vaultPath, { name: 'Refunds' }).category
    const database = openDatabase(vaultPath)
    const transactionId = insertTransaction(database, 'expense', account.id, -5_000)
    database.close()

    const result = setCategoryAssignments(vaultPath, transactionId, [
      { categoryId: refunds.id, amountMinor: -3_000, origin: 'explicit' },
    ])

    expect(result.transaction.amountMinor).toBe(-5_000)
    expect(result.assignments[0]).toMatchObject({
      amountMinor: -3_000,
      currency: 'USD',
    })
    expect(result.uncategorizedAmountMinor).toBe(-2_000)
    expect(() =>
      setCategoryAssignments(vaultPath, transactionId, [
        { categoryId: refunds.id, amountMinor: -5_001, origin: 'explicit' },
      ]),
    ).toThrow(/total -5001 cannot pass Transaction/)
  })

  it('rejects invalid totals, signs, duplicates, archived Categories, and Transaction kinds', () => {
    const fixture = createPositiveFixture()
    const archived = createCategory(fixture.vaultPath, { name: 'Archived' }).category
    archiveCategory(fixture.vaultPath, archived.id)

    expect(() =>
      setCategoryAssignments(fixture.vaultPath, fixture.transactionId, [
        { categoryId: fixture.categoryId, amountMinor: 100_001, origin: 'explicit' },
      ]),
    ).toThrow(/total 100001 cannot pass Transaction/)
    expect(() =>
      setCategoryAssignments(fixture.vaultPath, fixture.transactionId, [
        { categoryId: fixture.categoryId, amountMinor: -1, origin: 'explicit' },
      ]),
    ).toThrow(/must have the same sign/)
    expect(() =>
      setCategoryAssignments(fixture.vaultPath, fixture.transactionId, [
        { categoryId: fixture.categoryId, amountMinor: 10_000, origin: 'explicit' },
        { categoryId: fixture.categoryId, amountMinor: 20_000, origin: 'inferred' },
      ]),
    ).toThrow(/appears more than once/)
    expect(() =>
      setCategoryAssignments(fixture.vaultPath, fixture.transactionId, [
        { categoryId: archived.id, amountMinor: 10_000, origin: 'explicit' },
      ]),
    ).toThrow(/Archived Category.*cannot receive Assignments/)

    const database = openDatabase(fixture.vaultPath)
    const adjustmentId = insertTransaction(database, 'adjustment', fixture.accountId, 10_000)
    const secondAccount = createAccount(fixture.vaultPath, {
      name: 'Second',
      nature: 'asset',
      currency: 'KRW',
    }).account
    const transferId = Number(
      database
        .prepare(
          `INSERT INTO transactions (
             kind,
             occurred_on,
             source_account_id,
             source_amount_minor,
             destination_account_id,
             destination_amount_minor
           ) VALUES ('transfer', '2026-07-27', ?, 1000, ?, 1000)`,
        )
        .run(fixture.accountId, secondAccount.id).lastInsertRowid,
    )
    database.close()

    expect(() => setCategoryAssignments(fixture.vaultPath, adjustmentId, [])).toThrow(
      /Adjustment Transaction.*cannot receive Category Assignments/,
    )
    expect(() => setCategoryAssignments(fixture.vaultPath, transferId, [])).toThrow(
      /Transfer Transaction.*cannot receive Category Assignments/,
    )
  })

  it('writes Assignment changes in one atomic Transaction Change Record', () => {
    const fixture = createPositiveFixture()
    const database = openDatabase(fixture.vaultPath)
    database.exec(`
      CREATE TRIGGER test_reject_classification_change
      BEFORE INSERT ON change_records
      WHEN NEW.entity_type = 'transaction' AND NEW.action = 'updated'
      BEGIN
        SELECT RAISE(ABORT, 'forced classification Change Record failure');
      END;
    `)
    database.close()

    expect(() =>
      setCategoryAssignments(fixture.vaultPath, fixture.transactionId, [
        { categoryId: fixture.categoryId, amountMinor: 50_000, origin: 'inferred' },
      ]),
    ).toThrow(/forced classification Change Record failure/)
    expect(getTransactionClassification(fixture.vaultPath, fixture.transactionId)).toMatchObject({
      assignments: [],
      uncategorizedAmountMinor: 100_000,
    })

    const reopenedDatabase = openDatabase(fixture.vaultPath)
    reopenedDatabase.exec('DROP TRIGGER test_reject_classification_change')
    reopenedDatabase.close()
    const result = setCategoryAssignments(fixture.vaultPath, fixture.transactionId, [
      { categoryId: fixture.categoryId, amountMinor: 50_000, origin: 'inferred' },
    ])
    const finalDatabase = openDatabase(fixture.vaultPath)
    const record = finalDatabase
      .prepare(
        `SELECT payload
         FROM change_records
         WHERE entity_type = 'transaction' AND entity_id = ? AND action = 'updated'`,
      )
      .get(String(fixture.transactionId)) as { payload: string }
    finalDatabase.close()

    expect(JSON.parse(record.payload)).toEqual(result)
  })

  function createPositiveFixture(): {
    vaultPath: string
    accountId: number
    categoryId: number
    transactionId: number
  } {
    const vaultPath = createVault()
    const account = createAccount(vaultPath, {
      name: 'Cash',
      nature: 'asset',
      currency: 'KRW',
    }).account
    const living = createCategory(vaultPath, { name: 'Living' }).category
    const food = createCategory(vaultPath, { name: 'Food', parentId: living.id }).category
    const transaction = recordIncomeExpense(vaultPath, {
      kind: 'expense',
      accountId: account.id,
      amountMinor: 100_000,
      occurredOn: '2026-07-27',
    }).transaction

    return {
      vaultPath,
      accountId: account.id,
      categoryId: food.id,
      transactionId: transaction.id,
    }
  }

  function createVault(): string {
    const parentPath = mkdtempSync(join(tmpdir(), 'fin-category-assignment-test-'))
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

function insertTransaction(
  database: DatabaseSync,
  kind: 'expense' | 'adjustment',
  accountId: number,
  amountMinor: number,
): number {
  return Number(
    database
      .prepare(
        `INSERT INTO transactions (kind, occurred_on, account_id, amount_minor)
         VALUES (?, '2026-07-27', ?, ?)`,
      )
      .run(kind, accountId, amountMinor).lastInsertRowid,
  )
}
