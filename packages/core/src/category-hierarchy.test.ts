import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  archiveCategory,
  createAccount,
  createCategory,
  initializeVault,
  listCategories,
  reactivateCategory,
  updateCategory,
} from './index.js'

describe('Category hierarchy operations', () => {
  const temporaryDirectories: string[] = []

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { force: true, recursive: true })
    }
  })

  it('creates root and child Categories with complete paths up to three levels', () => {
    const vaultPath = createVault()
    const living = createCategory(vaultPath, { name: ' Living ' }).category
    const food = createCategory(vaultPath, { name: 'Food', parentId: living.id }).category
    const groceries = createCategory(vaultPath, {
      name: 'Groceries',
      parentId: food.id,
    }).category

    expect(living).toEqual({
      id: 1,
      parentId: null,
      name: 'Living',
      depth: 1,
      path: 'Living',
      archived: false,
    })
    expect(food.path).toBe('Living > Food')
    expect(food.depth).toBe(2)
    expect(groceries.path).toBe('Living > Food > Groceries')
    expect(groceries.depth).toBe(3)
    expect(() => createCategory(vaultPath, { name: 'Fresh', parentId: groceries.id })).toThrow(
      /cannot exceed three levels/,
    )
    expect(listCategories(vaultPath)).toEqual([living, food, groceries])
  })

  it('keeps names unique among siblings including archived Categories', () => {
    const vaultPath = createVault()
    const living = createCategory(vaultPath, { name: 'Living' }).category
    const travel = createCategory(vaultPath, { name: 'Travel' }).category
    const livingOther = createCategory(vaultPath, {
      name: 'Other',
      parentId: living.id,
    }).category
    const travelOther = createCategory(vaultPath, {
      name: 'Other',
      parentId: travel.id,
    }).category
    archiveCategory(vaultPath, livingOther.id)

    expect(() => createCategory(vaultPath, { name: ' other ', parentId: living.id })).toThrow(
      /already used by sibling Category 3.*Choose a unique sibling name/,
    )
    expect(() => createCategory(vaultPath, { name: 'living' })).toThrow(
      /already used by sibling Category 1/,
    )
    expect(travelOther.path).toBe('Travel > Other')
  })

  it('renames and moves a Category while updating descendant paths consistently', () => {
    const vaultPath = createVault()
    const living = createCategory(vaultPath, { name: 'Living' }).category
    const food = createCategory(vaultPath, { name: 'Food', parentId: living.id }).category
    const groceries = createCategory(vaultPath, {
      name: 'Groceries',
      parentId: food.id,
    }).category
    const travel = createCategory(vaultPath, { name: 'Travel' }).category

    const renamed = updateCategory(vaultPath, food.id, { name: 'Meals' })
    const moved = updateCategory(vaultPath, food.id, { parentId: travel.id })
    const categories = listCategories(vaultPath)

    expect(renamed.previousCategory.path).toBe('Living > Food')
    expect(renamed.category.path).toBe('Living > Meals')
    expect(moved.previousCategory.path).toBe('Living > Meals')
    expect(moved.category.path).toBe('Travel > Meals')
    expect(categories.find(({ id }) => id === groceries.id)?.path).toBe(
      'Travel > Meals > Groceries',
    )
    expect(categories.find(({ id }) => id === groceries.id)?.depth).toBe(3)
  })

  it('rejects moves that create cycles or paths deeper than three levels', () => {
    const vaultPath = createVault()
    const living = createCategory(vaultPath, { name: 'Living' }).category
    const food = createCategory(vaultPath, { name: 'Food', parentId: living.id }).category
    const groceries = createCategory(vaultPath, {
      name: 'Groceries',
      parentId: food.id,
    }).category
    const travel = createCategory(vaultPath, { name: 'Travel' }).category
    const asia = createCategory(vaultPath, { name: 'Asia', parentId: travel.id }).category

    expect(() => updateCategory(vaultPath, living.id, { parentId: groceries.id })).toThrow(
      /cannot move under its own descendant.*cannot contain cycles/,
    )
    expect(() => updateCategory(vaultPath, food.id, { parentId: asia.id })).toThrow(
      /cannot fit because Category paths cannot exceed three levels/,
    )
    expect(() => updateCategory(vaultPath, living.id, { parentId: living.id })).toThrow(
      /cannot be its own parent/,
    )
  })

  it('archives and reactivates a Category without losing historical assignments', () => {
    const vaultPath = createVault()
    const account = createAccount(vaultPath, {
      name: 'Cash',
      nature: 'asset',
      currency: 'KRW',
    }).account
    const food = createCategory(vaultPath, { name: 'Food' }).category
    const database = openDatabase(vaultPath)
    const firstTransactionId = insertExpense(database, account.id, 10_000)
    insertAssignment(database, firstTransactionId, food.id, 10_000)
    const secondTransactionId = insertExpense(database, account.id, 5_000)
    database.close()

    const archived = archiveCategory(vaultPath, food.id)
    const archivedDatabase = openDatabase(vaultPath)
    const assignmentCount = archivedDatabase
      .prepare('SELECT count(*) AS count FROM category_assignments WHERE category_id = ?')
      .get(food.id) as { count: number }

    expect(archived.category).toEqual({ ...food, archived: true })
    expect(listCategories(vaultPath)).toEqual([{ ...food, archived: true }])
    expect(assignmentCount.count).toBe(1)
    expect(() => insertAssignment(archivedDatabase, secondTransactionId, food.id, 5_000)).toThrow(
      /archived category cannot receive assignments/,
    )
    archivedDatabase.close()
    expect(() => createCategory(vaultPath, { name: 'Dining', parentId: food.id })).toThrow(
      /Archived Category 1.*cannot receive active children/,
    )

    const reactivated = reactivateCategory(vaultPath, food.id)
    const dining = createCategory(vaultPath, { name: 'Dining', parentId: food.id }).category

    expect(reactivated.category).toEqual(food)
    expect(dining.path).toBe('Food > Dining')
  })

  it('requires active children to be archived before their parent', () => {
    const vaultPath = createVault()
    const root = createCategory(vaultPath, { name: 'Root' }).category
    const child = createCategory(vaultPath, { name: 'Child', parentId: root.id }).category

    expect(() => archiveCategory(vaultPath, root.id)).toThrow(
      /cannot be archived while it has active child Category "Child"/,
    )

    archiveCategory(vaultPath, child.id)
    archiveCategory(vaultPath, root.id)
    expect(() => reactivateCategory(vaultPath, child.id)).toThrow(
      /Archived Category 1.*cannot receive active children/,
    )

    reactivateCategory(vaultPath, root.id)
    expect(reactivateCategory(vaultPath, child.id).category.archived).toBe(false)
  })

  it('writes detailed Category Change Records atomically', () => {
    const vaultPath = createVault()
    const category = createCategory(vaultPath, { name: 'Audited' }).category
    const database = openDatabase(vaultPath)
    database.exec(`
      CREATE TRIGGER test_reject_category_change
      BEFORE INSERT ON change_records
      WHEN NEW.entity_type = 'category' AND NEW.action = 'updated'
      BEGIN
        SELECT RAISE(ABORT, 'forced Category Change Record failure');
      END;
    `)
    database.close()

    expect(() => updateCategory(vaultPath, category.id, { name: 'Rolled Back' })).toThrow(
      /forced Category Change Record failure/,
    )
    expect(listCategories(vaultPath)).toEqual([category])

    const reopenedDatabase = openDatabase(vaultPath)
    reopenedDatabase.exec('DROP TRIGGER test_reject_category_change')
    reopenedDatabase.close()

    const updated = updateCategory(vaultPath, category.id, { name: 'Tracked' })
    const archived = archiveCategory(vaultPath, category.id)
    const reactivated = reactivateCategory(vaultPath, category.id)
    const finalDatabase = openDatabase(vaultPath)
    const rows = finalDatabase
      .prepare(
        `SELECT payload
         FROM change_records
         WHERE entity_type = 'category' AND action = 'updated'
         ORDER BY id`,
      )
      .all() as Array<{ payload: string }>
    finalDatabase.close()

    expect(rows.map(({ payload }) => JSON.parse(payload))).toEqual([updated, archived, reactivated])
  })

  function createVault(): string {
    const parentPath = mkdtempSync(join(tmpdir(), 'fin-category-test-'))
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

function insertExpense(database: DatabaseSync, accountId: number, amountMinor: number): number {
  return Number(
    database
      .prepare(
        `INSERT INTO transactions (kind, occurred_on, account_id, amount_minor)
         VALUES ('expense', '2026-07-27', ?, ?)`,
      )
      .run(accountId, amountMinor).lastInsertRowid,
  )
}

function insertAssignment(
  database: DatabaseSync,
  transactionId: number,
  categoryId: number,
  amountMinor: number,
): number {
  return Number(
    database
      .prepare(
        `INSERT INTO category_assignments (
           transaction_id,
           category_id,
           amount_minor,
           origin
         ) VALUES (?, ?, ?, 'explicit')`,
      )
      .run(transactionId, categoryId, amountMinor).lastInsertRowid,
  )
}
