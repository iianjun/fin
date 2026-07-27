import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const schemaSql = readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8')

type BalanceRow = {
  balance_minor: number
}

type CountRow = {
  count: number
}

describe('initial SQLite schema', () => {
  let database: DatabaseSync

  beforeEach(() => {
    database = new DatabaseSync(':memory:')
    database.exec(schemaSql)
  })

  afterEach(() => {
    database.close()
  })

  it('creates an empty vault without seeded accounts or categories', () => {
    const accountCount = database
      .prepare('SELECT count(*) AS count FROM accounts')
      .get() as CountRow
    const categoryCount = database
      .prepare('SELECT count(*) AS count FROM categories')
      .get() as CountRow
    const settingsCount = database
      .prepare('SELECT count(*) AS count FROM vault_settings')
      .get() as CountRow

    expect(accountCount.count).toBe(0)
    expect(categoryCount.count).toBe(0)
    expect(settingsCount.count).toBe(1)
  })

  it('counts a card purchase once and treats its payment as a transfer', () => {
    const bankId = insertAccount(database, 'Shinhan', 'asset', 'KRW')
    const cardId = insertAccount(database, 'Shinhan Card', 'liability', 'KRW')

    insertSingleAccountTransaction(database, 'adjustment', bankId, 1_000_000)
    insertSingleAccountTransaction(database, 'expense', cardId, 30_000)
    insertTransfer(database, bankId, 30_000, cardId, 30_000)

    expect(readBalance(database, bankId)).toBe(970_000)
    expect(readBalance(database, cardId)).toBe(0)
  })

  it('stores actual amounts for cross-currency transfers', () => {
    const wonId = insertAccount(database, 'Won', 'asset', 'KRW')
    const dollarId = insertAccount(database, 'Dollar', 'asset', 'USD')

    insertTransfer(database, dollarId, 100_000, wonId, 135_000_000)

    expect(readBalance(database, dollarId)).toBe(-100_000)
    expect(readBalance(database, wonId)).toBe(135_000_000)
  })

  it('rejects unequal amounts for a same-currency transfer', () => {
    const sourceId = insertAccount(database, 'Source', 'asset', 'KRW')
    const destinationId = insertAccount(database, 'Destination', 'asset', 'KRW')

    expect(() => insertTransfer(database, sourceId, 10_000, destinationId, 9_000)).toThrow(
      /same-currency transfer amounts must match/,
    )
  })

  it('enforces three category levels and sibling name uniqueness', () => {
    const livingId = insertCategory(database, 'Living')
    const foodId = insertCategory(database, 'Food', livingId)
    const groceriesId = insertCategory(database, 'Groceries', foodId)
    const travelId = insertCategory(database, 'Travel')

    expect(() => insertCategory(database, 'Fresh food', groceriesId)).toThrow(
      /cannot exceed three levels/,
    )
    expect(() => insertCategory(database, 'living')).toThrow(/UNIQUE constraint failed/)
    expect(() => insertCategory(database, 'Other', livingId)).not.toThrow()
    expect(() => insertCategory(database, 'Other', travelId)).not.toThrow()
  })

  it('rejects category moves that create a cycle or exceed three levels', () => {
    const livingId = insertCategory(database, 'Living')
    const foodId = insertCategory(database, 'Food', livingId)
    const groceriesId = insertCategory(database, 'Groceries', foodId)
    const travelId = insertCategory(database, 'Travel')

    expect(() =>
      database
        .prepare('UPDATE categories SET parent_id = ? WHERE id = ?')
        .run(groceriesId, livingId),
    ).toThrow(/cannot contain a cycle/)
    expect(() =>
      database.prepare('UPDATE categories SET parent_id = ? WHERE id = ?').run(travelId, livingId),
    ).toThrow(/cannot exceed three levels/)
  })

  it('supports partial category assignments without allowing an overflow', () => {
    const accountId = insertAccount(database, 'Cash', 'asset', 'KRW')
    const foodId = insertCategory(database, 'Food')
    const householdId = insertCategory(database, 'Household')
    const transactionId = insertSingleAccountTransaction(database, 'expense', accountId, 43_000)

    insertCategoryAssignment(database, transactionId, foodId, 30_000, 'inferred')

    const remainder = database
      .prepare(
        `SELECT uncategorized_amount_minor
         FROM transaction_uncategorized_amounts
         WHERE transaction_id = ?`,
      )
      .get(transactionId) as { uncategorized_amount_minor: number }

    expect(remainder.uncategorized_amount_minor).toBe(13_000)
    expect(() =>
      insertCategoryAssignment(database, transactionId, householdId, 14_000, 'explicit'),
    ).toThrow(/cannot exceed transaction amount/)
  })

  it('uses signed category assignments for refunds', () => {
    const accountId = insertAccount(database, 'Card', 'liability', 'KRW')
    const clothingId = insertCategory(database, 'Clothing')
    const refundId = insertSingleAccountTransaction(database, 'expense', accountId, -30_000)

    insertCategoryAssignment(database, refundId, clothingId, -30_000, 'explicit')

    expect(readBalance(database, accountId)).toBe(-30_000)
  })

  it('keeps a refund when its original expense is deleted', () => {
    const accountId = insertAccount(database, 'Card', 'liability', 'KRW')
    const expenseId = insertSingleAccountTransaction(database, 'expense', accountId, 100_000)
    const refundId = insertSingleAccountTransaction(database, 'expense', accountId, -30_000)

    database
      .prepare(
        `INSERT INTO transaction_relations (
           relation_kind,
           source_transaction_id,
           target_transaction_id
         ) VALUES ('refund_of', ?, ?)`,
      )
      .run(refundId, expenseId)
    database.prepare('DELETE FROM transactions WHERE id = ?').run(expenseId)

    const refundCount = database
      .prepare('SELECT count(*) AS count FROM transactions WHERE id = ?')
      .get(refundId) as CountRow
    const relationCount = database
      .prepare('SELECT count(*) AS count FROM transaction_relations')
      .get() as CountRow

    expect(refundCount.count).toBe(1)
    expect(relationCount.count).toBe(0)
  })

  it('protects account identity and archive invariants', () => {
    const accountId = insertAccount(database, 'Cash', 'asset', 'KRW')

    insertSingleAccountTransaction(database, 'adjustment', accountId, 10_000)

    expect(() =>
      database.prepare("UPDATE accounts SET currency = 'USD' WHERE id = ?").run(accountId),
    ).toThrow(/cannot change after first transaction/)
    expect(() =>
      database
        .prepare("UPDATE accounts SET archived_at = datetime('now') WHERE id = ?")
        .run(accountId),
    ).toThrow(/balance must be zero/)

    insertSingleAccountTransaction(database, 'adjustment', accountId, -10_000)
    database
      .prepare("UPDATE accounts SET archived_at = datetime('now') WHERE id = ?")
      .run(accountId)

    expect(() => insertSingleAccountTransaction(database, 'expense', accountId, 1_000)).toThrow(
      /archived account cannot receive new transactions/,
    )
  })

  it('does not use archived accounts as defaults', () => {
    const accountId = insertAccount(database, 'Cash', 'asset', 'KRW')

    database
      .prepare("UPDATE accounts SET archived_at = datetime('now') WHERE id = ?")
      .run(accountId)

    expect(() =>
      database.prepare('UPDATE vault_settings SET default_expense_account_id = ?').run(accountId),
    ).toThrow(/archived account cannot be a default account/)
    expect(() => database.prepare('DELETE FROM vault_settings').run()).toThrow(
      /vault settings cannot be deleted/,
    )
  })

  it('does not allow assignments to archived categories', () => {
    const accountId = insertAccount(database, 'Cash', 'asset', 'KRW')
    const categoryId = insertCategory(database, 'Food')
    const transactionId = insertSingleAccountTransaction(database, 'expense', accountId, 10_000)

    database
      .prepare("UPDATE categories SET archived_at = datetime('now') WHERE id = ?")
      .run(categoryId)

    expect(() =>
      insertCategoryAssignment(database, transactionId, categoryId, 10_000, 'explicit'),
    ).toThrow(/archived category cannot receive assignments/)
  })

  it('keeps change records immutable', () => {
    const changeId = Number(
      database
        .prepare(
          `INSERT INTO change_records (entity_type, entity_id, action, payload)
           VALUES ('transaction', '42', 'deleted', json(?))`,
        )
        .run('{"kind":"expense","amountMinor":12000}').lastInsertRowid,
    )

    expect(() =>
      database
        .prepare('UPDATE change_records SET action = ? WHERE id = ?')
        .run('updated', changeId),
    ).toThrow(/change records are immutable/)
    expect(() => database.prepare('DELETE FROM change_records WHERE id = ?').run(changeId)).toThrow(
      /change records are immutable/,
    )
  })
})

function insertAccount(
  database: DatabaseSync,
  name: string,
  nature: 'asset' | 'liability',
  currency: string,
): number {
  return Number(
    database
      .prepare('INSERT INTO accounts (name, nature, currency) VALUES (?, ?, ?)')
      .run(name, nature, currency).lastInsertRowid,
  )
}

function insertCategory(database: DatabaseSync, name: string, parentId?: number): number {
  return Number(
    database
      .prepare('INSERT INTO categories (name, parent_id) VALUES (?, ?)')
      .run(name, parentId ?? null).lastInsertRowid,
  )
}

function insertSingleAccountTransaction(
  database: DatabaseSync,
  kind: 'income' | 'expense' | 'adjustment',
  accountId: number,
  amountMinor: number,
): number {
  return Number(
    database
      .prepare(
        `INSERT INTO transactions (kind, occurred_on, account_id, amount_minor)
         VALUES (?, '2026-07-26', ?, ?)`,
      )
      .run(kind, accountId, amountMinor).lastInsertRowid,
  )
}

function insertTransfer(
  database: DatabaseSync,
  sourceAccountId: number,
  sourceAmountMinor: number,
  destinationAccountId: number,
  destinationAmountMinor: number,
): number {
  return Number(
    database
      .prepare(
        `INSERT INTO transactions (
           kind,
           occurred_on,
           source_account_id,
           source_amount_minor,
           destination_account_id,
           destination_amount_minor
         ) VALUES ('transfer', '2026-07-26', ?, ?, ?, ?)`,
      )
      .run(sourceAccountId, sourceAmountMinor, destinationAccountId, destinationAmountMinor)
      .lastInsertRowid,
  )
}

function insertCategoryAssignment(
  database: DatabaseSync,
  transactionId: number,
  categoryId: number,
  amountMinor: number,
  origin: 'explicit' | 'inferred',
): number {
  return Number(
    database
      .prepare(
        `INSERT INTO category_assignments (
           transaction_id,
           category_id,
           amount_minor,
           origin
         ) VALUES (?, ?, ?, ?)`,
      )
      .run(transactionId, categoryId, amountMinor, origin).lastInsertRowid,
  )
}

function readBalance(database: DatabaseSync, accountId: number): number {
  const row = database
    .prepare('SELECT balance_minor FROM account_balances WHERE account_id = ?')
    .get(accountId) as BalanceRow

  return row.balance_minor
}
