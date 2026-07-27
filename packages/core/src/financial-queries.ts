import type { DatabaseSync } from 'node:sqlite'
import type { Account, AccountNature } from './accounts.js'
import { listAccounts } from './accounts.js'
import type { CategoryAssignmentOrigin } from './classifications.js'
import type { TransactionRelationKind } from './related-expenses.js'
import type { TransactionKind } from './transaction-history.js'
import type { TransactionAccount } from './transactions.js'
import { validateCalendarDate } from './transactions.js'
import { withVaultDatabase } from './vault.js'

export type CurrencyAmount = {
  currency: string
  amountMinor: number
}

export type BalanceQueryResult = {
  accounts: Account[]
  netWorthByCurrency: CurrencyAmount[]
}

export type TransactionFilters = {
  dateFrom?: string | undefined
  dateTo?: string | undefined
  accountId?: number | undefined
  kinds?: TransactionKind[] | undefined
  memoContains?: string | undefined
}

export type AppliedTransactionFilters = {
  dateFrom: string | null
  dateTo: string | null
  accountId: number | null
  kinds: TransactionKind[]
  memoContains: string | null
}

export type QueryCategoryAssignment = {
  categoryId: number
  categoryPath: string
  amountMinor: number
  origin: CategoryAssignmentOrigin
  currency: string
}

export type QueryTransactionRelation = {
  relationKind: TransactionRelationKind
  direction: 'incoming' | 'outgoing'
  relatedTransactionId: number
}

type QueryTransactionBase = {
  id: number
  occurredOn: string
  memo: string | null
  relations: QueryTransactionRelation[]
}

export type QueryIncomeExpenseTransaction = QueryTransactionBase & {
  kind: 'income' | 'expense'
  account: TransactionAccount
  amountMinor: number
  assignments: QueryCategoryAssignment[]
  uncategorizedAmountMinor: number
}

export type QueryAdjustmentTransaction = QueryTransactionBase & {
  kind: 'adjustment'
  account: TransactionAccount
  amountMinor: number
}

export type QueryTransferTransaction = QueryTransactionBase & {
  kind: 'transfer'
  source: {
    account: TransactionAccount
    amountMinor: number
  }
  destination: {
    account: TransactionAccount
    amountMinor: number
  }
}

export type QueryTransaction =
  | QueryIncomeExpenseTransaction
  | QueryAdjustmentTransaction
  | QueryTransferTransaction

export type IncomeExpenseCurrencyTotal = {
  currency: string
  incomeMinor: number
  expenseMinor: number
  netIncomeMinor: number
  transactionIds: number[]
}

export type TransactionQueryResult = {
  filters: AppliedTransactionFilters
  transactions: QueryTransaction[]
  incomeExpenseTotalsByCurrency: IncomeExpenseCurrencyTotal[]
}

export type SpendingFilters = Omit<TransactionFilters, 'kinds'> & {
  categoryId?: number | undefined
}

export type AppliedSpendingFilters = Omit<AppliedTransactionFilters, 'kinds'> & {
  categoryId: number | null
}

export type CategorySpendingRollup = {
  categoryId: number
  categoryPath: string
  currency: string
  amountMinor: number
  transactionIds: number[]
}

export type SpendingQueryResult = {
  filters: AppliedSpendingFilters
  transactions: QueryIncomeExpenseTransaction[]
  expenseTotalsByCurrency: CurrencyAmount[]
  uncategorizedByCurrency: CurrencyAmount[]
  categoryRollups: CategorySpendingRollup[]
}

type TransactionRow = {
  id: number
  kind: TransactionKind
  occurred_on: string
  memo: string | null
  account_id: number | null
  amount_minor: number | null
  account_name: string | null
  account_nature: AccountNature | null
  account_currency: string | null
  account_archived_at: string | null
  source_account_id: number | null
  source_amount_minor: number | null
  source_account_name: string | null
  source_account_nature: AccountNature | null
  source_account_currency: string | null
  source_account_archived_at: string | null
  destination_account_id: number | null
  destination_amount_minor: number | null
  destination_account_name: string | null
  destination_account_nature: AccountNature | null
  destination_account_currency: string | null
  destination_account_archived_at: string | null
}

type AssignmentRow = {
  category_id: number
  category_path: string
  amount_minor: number
  origin: CategoryAssignmentOrigin
  currency: string
}

type RelationRow = {
  relation_kind: TransactionRelationKind
  source_transaction_id: number
  target_transaction_id: number
}

type UncategorizedRow = {
  uncategorized_amount_minor: number
}

type CategoryNode = {
  id: number
  parentId: number | null
  path: string
}

type CategoryRow = {
  id: number
  parent_id: number | null
  path: string
}

export function queryBalances(vaultPath: string): BalanceQueryResult {
  const accounts = listAccounts(vaultPath)
  const totals = new Map<string, number>()

  for (const account of accounts) {
    const netWorthEffect = account.nature === 'asset' ? account.balanceMinor : -account.balanceMinor
    totals.set(account.currency, (totals.get(account.currency) ?? 0) + netWorthEffect)
  }

  return {
    accounts,
    netWorthByCurrency: mapCurrencyAmounts(totals),
  }
}

export function queryTransactions(
  vaultPath: string,
  filters: TransactionFilters = {},
): TransactionQueryResult {
  const appliedFilters = validateTransactionFilters(filters)

  return withVaultDatabase(vaultPath, (database) => {
    const rows = readTransactionRows(database, appliedFilters)
    const transactions = rows.map((row) => mapTransaction(database, row))

    return {
      filters: appliedFilters,
      transactions,
      incomeExpenseTotalsByCurrency: totalIncomeAndExpense(transactions),
    }
  })
}

export function querySpending(
  vaultPath: string,
  filters: SpendingFilters = {},
): SpendingQueryResult {
  const categoryId =
    filters.categoryId === undefined ? null : validatePositiveId(filters.categoryId, 'Category')
  const transactionResult = queryTransactions(vaultPath, {
    dateFrom: filters.dateFrom,
    dateTo: filters.dateTo,
    accountId: filters.accountId,
    kinds: ['expense'],
    memoContains: filters.memoContains,
  })

  return withVaultDatabase(vaultPath, (database) => {
    const categories = readCategoryNodes(database)
    const categoryById = new Map(categories.map((category) => [category.id, category]))

    if (categoryId !== null && !categoryById.has(categoryId)) {
      throw new Error(`Category ${categoryId} does not exist`)
    }

    const expenses = transactionResult.transactions.filter(
      (transaction): transaction is QueryIncomeExpenseTransaction => transaction.kind === 'expense',
    )
    const transactions =
      categoryId === null
        ? expenses
        : expenses.filter((transaction) =>
            transaction.assignments.some((assignment) =>
              isCategoryWithin(categoryById, assignment.categoryId, categoryId),
            ),
          )
    const expenseTotals = new Map<string, number>()
    const uncategorizedTotals = new Map<string, number>()
    const rollups = new Map<
      string,
      {
        category: CategoryNode
        currency: string
        amountMinor: number
        transactionIds: Set<number>
      }
    >()

    for (const transaction of transactions) {
      const currency = transaction.account.currency
      expenseTotals.set(currency, (expenseTotals.get(currency) ?? 0) + transaction.amountMinor)
      uncategorizedTotals.set(
        currency,
        (uncategorizedTotals.get(currency) ?? 0) + transaction.uncategorizedAmountMinor,
      )

      for (const assignment of transaction.assignments) {
        if (
          categoryId !== null &&
          !isCategoryWithin(categoryById, assignment.categoryId, categoryId)
        ) {
          continue
        }

        for (const category of readRollupAncestors(
          categoryById,
          assignment.categoryId,
          categoryId,
        )) {
          const key = `${category.id}:${assignment.currency}`
          const current = rollups.get(key) ?? {
            category,
            currency: assignment.currency,
            amountMinor: 0,
            transactionIds: new Set<number>(),
          }
          current.amountMinor += assignment.amountMinor
          current.transactionIds.add(transaction.id)
          rollups.set(key, current)
        }
      }
    }

    return {
      filters: {
        dateFrom: transactionResult.filters.dateFrom,
        dateTo: transactionResult.filters.dateTo,
        accountId: transactionResult.filters.accountId,
        memoContains: transactionResult.filters.memoContains,
        categoryId,
      },
      transactions,
      expenseTotalsByCurrency: mapCurrencyAmounts(expenseTotals),
      uncategorizedByCurrency: mapCurrencyAmounts(uncategorizedTotals),
      categoryRollups: [...rollups.values()]
        .map((rollup) => ({
          categoryId: rollup.category.id,
          categoryPath: rollup.category.path,
          currency: rollup.currency,
          amountMinor: rollup.amountMinor,
          transactionIds: [...rollup.transactionIds].sort((left, right) => left - right),
        }))
        .sort(
          (left, right) =>
            left.currency.localeCompare(right.currency) ||
            left.categoryPath.localeCompare(right.categoryPath) ||
            left.categoryId - right.categoryId,
        ),
    }
  })
}

function validateTransactionFilters(filters: TransactionFilters): AppliedTransactionFilters {
  const dateFrom = filters.dateFrom === undefined ? null : validateCalendarDate(filters.dateFrom)
  const dateTo = filters.dateTo === undefined ? null : validateCalendarDate(filters.dateTo)

  if (dateFrom !== null && dateTo !== null && dateFrom > dateTo) {
    throw new Error('Transaction dateFrom must be on or before dateTo')
  }

  const accountId =
    filters.accountId === undefined ? null : validatePositiveId(filters.accountId, 'Account')
  const kinds =
    filters.kinds === undefined ? [] : [...new Set(filters.kinds.map(validateTransactionKind))]
  const memoContains = filters.memoContains === undefined ? null : filters.memoContains.trim()

  if (memoContains !== null && memoContains.length === 0) {
    throw new Error('Memo search text must not be empty')
  }

  return {
    dateFrom,
    dateTo,
    accountId,
    kinds,
    memoContains,
  }
}

function validatePositiveId(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} ID must be a positive integer`)
  }

  return value
}

function validateTransactionKind(kind: TransactionKind): TransactionKind {
  if (kind !== 'income' && kind !== 'expense' && kind !== 'transfer' && kind !== 'adjustment') {
    throw new Error(`Unsupported Transaction kind "${String(kind)}"`)
  }

  return kind
}

function readTransactionRows(
  database: DatabaseSync,
  filters: AppliedTransactionFilters,
): TransactionRow[] {
  const conditions: string[] = []
  const parameters: Array<string | number> = []

  if (filters.dateFrom !== null) {
    conditions.push('transactions.occurred_on >= ?')
    parameters.push(filters.dateFrom)
  }

  if (filters.dateTo !== null) {
    conditions.push('transactions.occurred_on <= ?')
    parameters.push(filters.dateTo)
  }

  if (filters.accountId !== null) {
    conditions.push(
      `(transactions.account_id = ?
        OR transactions.source_account_id = ?
        OR transactions.destination_account_id = ?)`,
    )
    parameters.push(filters.accountId, filters.accountId, filters.accountId)
  }

  if (filters.kinds.length > 0) {
    conditions.push(`transactions.kind IN (${filters.kinds.map(() => '?').join(', ')})`)
    parameters.push(...filters.kinds)
  }

  if (filters.memoContains !== null) {
    conditions.push(`instr(lower(COALESCE(transactions.memo, '')), lower(?)) > 0`)
    parameters.push(filters.memoContains)
  }

  const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`

  return database
    .prepare(
      `SELECT
         transactions.id,
         transactions.kind,
         transactions.occurred_on,
         transactions.memo,
         transactions.account_id,
         transactions.amount_minor,
         account.name AS account_name,
         account.nature AS account_nature,
         account.currency AS account_currency,
         account.archived_at AS account_archived_at,
         transactions.source_account_id,
         transactions.source_amount_minor,
         source_account.name AS source_account_name,
         source_account.nature AS source_account_nature,
         source_account.currency AS source_account_currency,
         source_account.archived_at AS source_account_archived_at,
         transactions.destination_account_id,
         transactions.destination_amount_minor,
         destination_account.name AS destination_account_name,
         destination_account.nature AS destination_account_nature,
         destination_account.currency AS destination_account_currency,
         destination_account.archived_at AS destination_account_archived_at
       FROM transactions
       LEFT JOIN accounts AS account ON account.id = transactions.account_id
       LEFT JOIN accounts AS source_account ON source_account.id = transactions.source_account_id
       LEFT JOIN accounts AS destination_account
         ON destination_account.id = transactions.destination_account_id
       ${where}
       ORDER BY transactions.occurred_on, transactions.id`,
    )
    .all(...parameters) as TransactionRow[]
}

function mapTransaction(database: DatabaseSync, row: TransactionRow): QueryTransaction {
  const base = {
    id: row.id,
    occurredOn: row.occurred_on,
    memo: row.memo,
    relations: readRelations(database, row.id),
  }

  if (row.kind === 'transfer') {
    return {
      ...base,
      kind: 'transfer',
      source: {
        account: mapAccount(row, 'source'),
        amountMinor: requireNumber(row.source_amount_minor, 'Transfer source amount'),
      },
      destination: {
        account: mapAccount(row, 'destination'),
        amountMinor: requireNumber(row.destination_amount_minor, 'Transfer destination amount'),
      },
    }
  }

  const account = mapAccount(row, 'account')
  const amountMinor = requireNumber(row.amount_minor, `${row.kind} amount`)

  if (row.kind === 'adjustment') {
    return {
      ...base,
      kind: 'adjustment',
      account,
      amountMinor,
    }
  }

  return {
    ...base,
    kind: row.kind,
    account,
    amountMinor,
    assignments: readAssignments(database, row.id),
    uncategorizedAmountMinor: readUncategorizedAmount(database, row.id),
  }
}

function mapAccount(
  row: TransactionRow,
  prefix: 'account' | 'source' | 'destination',
): TransactionAccount {
  const id =
    prefix === 'account'
      ? row.account_id
      : prefix === 'source'
        ? row.source_account_id
        : row.destination_account_id
  const name =
    prefix === 'account'
      ? row.account_name
      : prefix === 'source'
        ? row.source_account_name
        : row.destination_account_name
  const nature =
    prefix === 'account'
      ? row.account_nature
      : prefix === 'source'
        ? row.source_account_nature
        : row.destination_account_nature
  const currency =
    prefix === 'account'
      ? row.account_currency
      : prefix === 'source'
        ? row.source_account_currency
        : row.destination_account_currency
  const archivedAt =
    prefix === 'account'
      ? row.account_archived_at
      : prefix === 'source'
        ? row.source_account_archived_at
        : row.destination_account_archived_at

  if (id === null || name === null || nature === null || currency === null) {
    throw new Error(`Transaction ${row.id} has a missing ${prefix} Account`)
  }

  return {
    id,
    name,
    nature,
    currency,
    archived: archivedAt !== null,
  }
}

function readAssignments(database: DatabaseSync, transactionId: number): QueryCategoryAssignment[] {
  const rows = database
    .prepare(
      `SELECT
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
    categoryId: row.category_id,
    categoryPath: row.category_path,
    amountMinor: row.amount_minor,
    origin: row.origin,
    currency: row.currency,
  }))
}

function readUncategorizedAmount(database: DatabaseSync, transactionId: number): number {
  const row = database
    .prepare(
      `SELECT uncategorized_amount_minor
       FROM transaction_uncategorized_amounts
       WHERE transaction_id = ?`,
    )
    .get(transactionId) as UncategorizedRow | undefined

  if (!row) {
    throw new Error(`Transaction ${transactionId} has no uncategorized amount`)
  }

  return row.uncategorized_amount_minor
}

function readRelations(database: DatabaseSync, transactionId: number): QueryTransactionRelation[] {
  const rows = database
    .prepare(
      `SELECT relation_kind, source_transaction_id, target_transaction_id
       FROM transaction_relations
       WHERE source_transaction_id = ? OR target_transaction_id = ?
       ORDER BY id`,
    )
    .all(transactionId, transactionId) as RelationRow[]

  return rows.map((row) => {
    const outgoing = row.source_transaction_id === transactionId

    return {
      relationKind: row.relation_kind,
      direction: outgoing ? 'outgoing' : 'incoming',
      relatedTransactionId: outgoing ? row.target_transaction_id : row.source_transaction_id,
    }
  })
}

function totalIncomeAndExpense(transactions: QueryTransaction[]): IncomeExpenseCurrencyTotal[] {
  const totals = new Map<
    string,
    {
      incomeMinor: number
      expenseMinor: number
      transactionIds: Set<number>
    }
  >()

  for (const transaction of transactions) {
    if (transaction.kind !== 'income' && transaction.kind !== 'expense') {
      continue
    }

    const currency = transaction.account.currency
    const current = totals.get(currency) ?? {
      incomeMinor: 0,
      expenseMinor: 0,
      transactionIds: new Set<number>(),
    }

    if (transaction.kind === 'income') {
      current.incomeMinor += transaction.amountMinor
    } else {
      current.expenseMinor += transaction.amountMinor
    }

    current.transactionIds.add(transaction.id)
    totals.set(currency, current)
  }

  return [...totals.entries()]
    .map(([currency, total]) => ({
      currency,
      incomeMinor: total.incomeMinor,
      expenseMinor: total.expenseMinor,
      netIncomeMinor: total.incomeMinor - total.expenseMinor,
      transactionIds: [...total.transactionIds].sort((left, right) => left - right),
    }))
    .sort((left, right) => left.currency.localeCompare(right.currency))
}

function readCategoryNodes(database: DatabaseSync): CategoryNode[] {
  const rows = database
    .prepare(
      `SELECT categories.id, categories.parent_id, category_paths.path
       FROM categories
       JOIN category_paths ON category_paths.id = categories.id
       ORDER BY categories.id`,
    )
    .all() as CategoryRow[]

  return rows.map((row) => ({
    id: row.id,
    parentId: row.parent_id,
    path: row.path,
  }))
}

function isCategoryWithin(
  categoryById: Map<number, CategoryNode>,
  candidateId: number,
  ancestorId: number,
): boolean {
  let current = categoryById.get(candidateId)

  while (current) {
    if (current.id === ancestorId) {
      return true
    }

    current = current.parentId === null ? undefined : categoryById.get(current.parentId)
  }

  return false
}

function readRollupAncestors(
  categoryById: Map<number, CategoryNode>,
  categoryId: number,
  stopAtCategoryId: number | null,
): CategoryNode[] {
  const ancestors: CategoryNode[] = []
  let current = categoryById.get(categoryId)

  while (current) {
    ancestors.push(current)

    if (current.id === stopAtCategoryId) {
      break
    }

    current = current.parentId === null ? undefined : categoryById.get(current.parentId)
  }

  return ancestors
}

function mapCurrencyAmounts(totals: Map<string, number>): CurrencyAmount[] {
  return [...totals.entries()]
    .map(([currency, amountMinor]) => ({ currency, amountMinor }))
    .sort((left, right) => left.currency.localeCompare(right.currency))
}

function requireNumber(value: number | null, label: string): number {
  if (value === null) {
    throw new Error(`${label} is missing`)
  }

  return value
}
