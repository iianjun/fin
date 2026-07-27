import type { DatabaseSync } from 'node:sqlite'
import type { AccountNature } from './accounts.js'
import { insertChangeRecord, runMutation } from './persistence.js'
import { withVaultDatabase } from './vault.js'

export type IncomeExpenseKind = 'income' | 'expense'

export type IncomeExpenseCreation = {
  kind: IncomeExpenseKind
  accountId: number
  amountMinor: number
  occurredOn: string
  memo?: string | null | undefined
}

export type TransactionAccount = {
  id: number
  name: string
  nature: AccountNature
  currency: string
  archived: boolean
}

export type IncomeExpenseTransaction = {
  id: number
  kind: IncomeExpenseKind
  occurredOn: string
  account: TransactionAccount
  amountMinor: number
  memo: string | null
}

export type RecordIncomeExpenseResult = {
  action: 'created'
  transaction: IncomeExpenseTransaction
  previousBalanceMinor: number
  resultingBalanceMinor: number
}

type AccountRow = {
  id: number
  name: string
  nature: AccountNature
  currency: string
  archived_at: string | null
  balance_minor: number
}

type TransactionRow = {
  id: number
  kind: IncomeExpenseKind
  occurred_on: string
  account_id: number
  account_name: string
  account_nature: AccountNature
  account_currency: string
  account_archived_at: string | null
  amount_minor: number
  memo: string | null
}

export function recordIncomeExpense(
  vaultPath: string,
  creation: IncomeExpenseCreation,
): RecordIncomeExpenseResult {
  const kind = validateIncomeExpenseKind(creation.kind)
  const accountId = validatePositiveId(creation.accountId, 'Account')
  const amountMinor = validatePositiveAmount(creation.amountMinor)
  const occurredOn = validateCalendarDate(creation.occurredOn)
  const memo = normalizeMemo(creation.memo)

  return withVaultDatabase(vaultPath, (database) =>
    runMutation(database, () => {
      const account = readAccount(database, accountId)

      if (account.archived_at !== null) {
        throw new Error(
          `Archived Account ${account.id} ("${account.name}") cannot receive new Transactions`,
        )
      }

      const transactionId = Number(
        database
          .prepare(
            `INSERT INTO transactions (kind, occurred_on, account_id, amount_minor, memo)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(kind, occurredOn, accountId, amountMinor, memo).lastInsertRowid,
      )
      const transaction = readIncomeExpenseTransactionFromDatabase(database, transactionId)
      const resultingBalanceMinor = readAccountBalance(database, accountId)
      const result = {
        action: 'created' as const,
        transaction,
        previousBalanceMinor: account.balance_minor,
        resultingBalanceMinor,
      }

      insertChangeRecord(database, 'transaction', String(transactionId), 'created', result)

      return result
    }),
  )
}

export function listIncomeExpenseTransactions(vaultPath: string): IncomeExpenseTransaction[] {
  return withVaultDatabase(vaultPath, (database) => {
    const rows = database
      .prepare(
        `${incomeExpenseSelect}
         WHERE transactions.kind IN ('income', 'expense')
         ORDER BY transactions.occurred_on DESC, transactions.id DESC`,
      )
      .all() as TransactionRow[]

    return rows.map(mapTransactionRow)
  })
}

export function getIncomeExpenseTransaction(
  vaultPath: string,
  transactionId: number,
): IncomeExpenseTransaction {
  const validatedTransactionId = validatePositiveId(transactionId, 'Transaction')

  return withVaultDatabase(vaultPath, (database) =>
    readIncomeExpenseTransactionFromDatabase(database, validatedTransactionId),
  )
}

const incomeExpenseSelect = `
  SELECT
    transactions.id,
    transactions.kind,
    transactions.occurred_on,
    transactions.account_id,
    accounts.name AS account_name,
    accounts.nature AS account_nature,
    accounts.currency AS account_currency,
    accounts.archived_at AS account_archived_at,
    transactions.amount_minor,
    transactions.memo
  FROM transactions
  JOIN accounts ON accounts.id = transactions.account_id
`

function validateIncomeExpenseKind(kind: IncomeExpenseKind): IncomeExpenseKind {
  if (kind !== 'income' && kind !== 'expense') {
    throw new Error('Transaction kind must be either "income" or "expense"')
  }

  return kind
}

function validatePositiveId(id: number, entityName: 'Account' | 'Transaction'): number {
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`${entityName} ID must be a positive integer`)
  }

  return id
}

function validatePositiveAmount(amountMinor: number): number {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw new Error('Income and Expense amounts must be positive integer minor units')
  }

  return amountMinor
}

function validateCalendarDate(occurredOn: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(occurredOn)) {
    throw new Error('Transaction date must use the YYYY-MM-DD calendar format')
  }

  const parsedDate = new Date(`${occurredOn}T00:00:00.000Z`)

  if (Number.isNaN(parsedDate.valueOf()) || parsedDate.toISOString().slice(0, 10) !== occurredOn) {
    throw new Error(`Transaction date "${occurredOn}" is not a valid calendar date`)
  }

  return occurredOn
}

function normalizeMemo(memo: string | null | undefined): string | null {
  if (memo === null || memo === undefined) {
    return null
  }

  const normalizedMemo = memo.trim()
  return normalizedMemo.length === 0 ? null : normalizedMemo
}

function readAccount(database: DatabaseSync, accountId: number): AccountRow {
  const row = database
    .prepare(
      `SELECT
         accounts.id,
         accounts.name,
         accounts.nature,
         accounts.currency,
         accounts.archived_at,
         account_balances.balance_minor
       FROM accounts
       JOIN account_balances ON account_balances.account_id = accounts.id
       WHERE accounts.id = ?`,
    )
    .get(accountId) as AccountRow | undefined

  if (!row) {
    throw new Error(`Account ${accountId} does not exist`)
  }

  return row
}

function readAccountBalance(database: DatabaseSync, accountId: number): number {
  const row = database
    .prepare(
      `SELECT balance_minor
       FROM account_balances
       WHERE account_id = ?`,
    )
    .get(accountId) as { balance_minor: number } | undefined

  if (!row) {
    throw new Error(`Account ${accountId} does not exist`)
  }

  return row.balance_minor
}

export function readIncomeExpenseTransactionFromDatabase(
  database: DatabaseSync,
  transactionId: number,
): IncomeExpenseTransaction {
  const row = database
    .prepare(
      `${incomeExpenseSelect}
       WHERE transactions.id = ?
         AND transactions.kind IN ('income', 'expense')`,
    )
    .get(transactionId) as TransactionRow | undefined

  if (!row) {
    throw new Error(`Income or Expense Transaction ${transactionId} does not exist`)
  }

  return mapTransactionRow(row)
}

function mapTransactionRow(row: TransactionRow): IncomeExpenseTransaction {
  return {
    id: row.id,
    kind: row.kind,
    occurredOn: row.occurred_on,
    account: {
      id: row.account_id,
      name: row.account_name,
      nature: row.account_nature,
      currency: row.account_currency,
      archived: row.account_archived_at !== null,
    },
    amountMinor: row.amount_minor,
    memo: row.memo,
  }
}
