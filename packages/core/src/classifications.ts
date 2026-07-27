import type { DatabaseSync } from 'node:sqlite'
import type { Category } from './categories.js'
import { insertChangeRecord, runMutation } from './persistence.js'
import {
  type IncomeExpenseTransaction,
  readIncomeExpenseTransactionFromDatabase,
} from './transactions.js'
import { withVaultDatabase } from './vault.js'

export type CategoryAssignmentOrigin = 'explicit' | 'inferred'

export type CategoryAssignmentInput = {
  categoryId: number
  amountMinor: number
  origin: CategoryAssignmentOrigin
}

export type CategoryAssignment = {
  id: number
  category: Pick<Category, 'id' | 'path'>
  amountMinor: number
  origin: CategoryAssignmentOrigin
  currency: string
}

export type TransactionClassification = {
  transaction: IncomeExpenseTransaction
  assignments: CategoryAssignment[]
  uncategorizedAmountMinor: number
}

export type SetCategoryAssignmentsResult = TransactionClassification & {
  action: 'updated'
  previousAssignments: CategoryAssignment[]
}

type AssignmentRow = {
  id: number
  category_id: number
  category_path: string
  amount_minor: number
  origin: CategoryAssignmentOrigin
  currency: string
}

type CategoryRow = {
  id: number
  path: string
  archived_at: string | null
}

export function setCategoryAssignments(
  vaultPath: string,
  transactionId: number,
  assignmentInputs: CategoryAssignmentInput[],
): SetCategoryAssignmentsResult {
  const validatedTransactionId = validatePositiveId(transactionId, 'Transaction')
  const validatedAssignments = assignmentInputs.map(validateAssignmentInput)
  ensureUniqueCategories(validatedAssignments)

  return withVaultDatabase(vaultPath, (database) =>
    runMutation(database, () => {
      const transaction = readClassifiableTransaction(database, validatedTransactionId)
      const categories = validatedAssignments.map((assignment) =>
        readActiveCategory(database, assignment.categoryId),
      )

      validateAssignmentAmounts(transaction, validatedAssignments)

      const previousAssignments = readCategoryAssignments(database, validatedTransactionId)
      database
        .prepare('DELETE FROM category_assignments WHERE transaction_id = ?')
        .run(validatedTransactionId)
      const insertAssignment = database.prepare(
        `INSERT INTO category_assignments (
           transaction_id,
           category_id,
           amount_minor,
           origin
         ) VALUES (?, ?, ?, ?)`,
      )

      for (const [index, assignment] of validatedAssignments.entries()) {
        const category = categories[index]

        if (!category) {
          throw new Error('Validated Category is missing')
        }

        insertAssignment.run(
          validatedTransactionId,
          category.id,
          assignment.amountMinor,
          assignment.origin,
        )
      }

      const classification = readTransactionClassificationFromDatabase(
        database,
        validatedTransactionId,
      )
      const result = {
        action: 'updated' as const,
        ...classification,
        previousAssignments,
      }

      insertChangeRecord(database, 'transaction', String(validatedTransactionId), 'updated', result)

      return result
    }),
  )
}

export function getTransactionClassification(
  vaultPath: string,
  transactionId: number,
): TransactionClassification {
  const validatedTransactionId = validatePositiveId(transactionId, 'Transaction')

  return withVaultDatabase(vaultPath, (database) =>
    readTransactionClassificationFromDatabase(database, validatedTransactionId),
  )
}

function readTransactionClassificationFromDatabase(
  database: DatabaseSync,
  transactionId: number,
): TransactionClassification {
  const transaction = readClassifiableTransaction(database, transactionId)
  const assignments = readCategoryAssignments(database, transactionId)
  const remainder = database
    .prepare(
      `SELECT uncategorized_amount_minor
       FROM transaction_uncategorized_amounts
       WHERE transaction_id = ?`,
    )
    .get(transactionId) as { uncategorized_amount_minor: number } | undefined

  if (!remainder) {
    throw new Error(`Transaction ${transactionId} does not have a categorization remainder`)
  }

  return {
    transaction,
    assignments,
    uncategorizedAmountMinor: remainder.uncategorized_amount_minor,
  }
}

function validateAssignmentInput(
  assignment: CategoryAssignmentInput,
  index: number,
): CategoryAssignmentInput {
  const categoryId = validatePositiveId(assignment.categoryId, 'Category')

  if (!Number.isSafeInteger(assignment.amountMinor) || assignment.amountMinor === 0) {
    throw new Error(`Category Assignment ${index + 1} amount must be nonzero integer minor units`)
  }

  if (assignment.origin !== 'explicit' && assignment.origin !== 'inferred') {
    throw new Error(`Category Assignment ${index + 1} origin must be "explicit" or "inferred"`)
  }

  return {
    categoryId,
    amountMinor: assignment.amountMinor,
    origin: assignment.origin,
  }
}

function validatePositiveId(id: number, entityName: 'Transaction' | 'Category'): number {
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`${entityName} ID must be a positive integer`)
  }

  return id
}

function ensureUniqueCategories(assignments: CategoryAssignmentInput[]): void {
  const categoryIds = new Set<number>()

  for (const assignment of assignments) {
    if (categoryIds.has(assignment.categoryId)) {
      throw new Error(
        `Category ${assignment.categoryId} appears more than once. Combine its assigned amounts.`,
      )
    }

    categoryIds.add(assignment.categoryId)
  }
}

function validateAssignmentAmounts(
  transaction: IncomeExpenseTransaction,
  assignments: CategoryAssignmentInput[],
): void {
  const assignedAmountMinor = assignments.reduce(
    (sum, assignment) => sum + assignment.amountMinor,
    0,
  )

  if (!Number.isSafeInteger(assignedAmountMinor)) {
    throw new Error('Category Assignment total must remain within integer-safe minor units')
  }

  for (const assignment of assignments) {
    if (Math.sign(assignment.amountMinor) !== Math.sign(transaction.amountMinor)) {
      throw new Error(
        `Category Assignment amount ${assignment.amountMinor} must have the same sign as ` +
          `Transaction ${transaction.id} amount ${transaction.amountMinor}`,
      )
    }
  }

  const exceedsTransaction =
    transaction.amountMinor > 0
      ? assignedAmountMinor > transaction.amountMinor
      : assignedAmountMinor < transaction.amountMinor

  if (exceedsTransaction) {
    throw new Error(
      `Category Assignment total ${assignedAmountMinor} cannot pass Transaction ` +
        `${transaction.id} amount ${transaction.amountMinor}`,
    )
  }
}

function readClassifiableTransaction(
  database: DatabaseSync,
  transactionId: number,
): IncomeExpenseTransaction {
  const row = database.prepare('SELECT kind FROM transactions WHERE id = ?').get(transactionId) as
    | { kind: string }
    | undefined

  if (!row) {
    throw new Error(`Transaction ${transactionId} does not exist`)
  }

  if (row.kind !== 'income' && row.kind !== 'expense') {
    throw new Error(
      `${formatTransactionKind(row.kind)} Transaction ${transactionId} cannot receive ` +
        'Category Assignments',
    )
  }

  return readIncomeExpenseTransactionFromDatabase(database, transactionId)
}

function readActiveCategory(database: DatabaseSync, categoryId: number): CategoryRow {
  const row = database
    .prepare(
      `SELECT id, path, archived_at
       FROM category_paths
       WHERE id = ?`,
    )
    .get(categoryId) as CategoryRow | undefined

  if (!row) {
    throw new Error(`Category ${categoryId} does not exist`)
  }

  if (row.archived_at !== null) {
    throw new Error(`Archived Category ${categoryId} ("${row.path}") cannot receive Assignments`)
  }

  return row
}

function readCategoryAssignments(
  database: DatabaseSync,
  transactionId: number,
): CategoryAssignment[] {
  const rows = database
    .prepare(
      `SELECT
         category_assignments.id,
         category_assignments.category_id,
         category_paths.path AS category_path,
         category_assignments.amount_minor,
         category_assignments.origin,
         accounts.currency
       FROM category_assignments
       JOIN category_paths ON category_paths.id = category_assignments.category_id
       JOIN transactions ON transactions.id = category_assignments.transaction_id
       JOIN accounts ON accounts.id = transactions.account_id
       WHERE category_assignments.transaction_id = ?
       ORDER BY category_assignments.id`,
    )
    .all(transactionId) as AssignmentRow[]

  return rows.map((row) => ({
    id: row.id,
    category: {
      id: row.category_id,
      path: row.category_path,
    },
    amountMinor: row.amount_minor,
    origin: row.origin,
    currency: row.currency,
  }))
}

function formatTransactionKind(kind: string): string {
  return kind.charAt(0).toUpperCase() + kind.slice(1)
}
