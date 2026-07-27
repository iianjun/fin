import type { DatabaseSync } from 'node:sqlite'
import type { AccountNature } from './accounts.js'
import { insertChangeRecord, runMutation } from './persistence.js'
import {
  type IncomeExpenseTransaction,
  normalizeMemo,
  readIncomeExpenseTransactionFromDatabase,
  validateCalendarDate,
} from './transactions.js'
import { withVaultDatabase } from './vault.js'

export type RefundRequest = {
  accountId: number
  amountMinor: number
  occurredOn: string
  memo?: string | null | undefined
  originalExpenseId?: number | null | undefined
}

export type TransferFeeRequest = {
  accountId: number
  amountMinor: number
  occurredOn: string
  memo?: string | null | undefined
  transferId: number
}

export type TransactionRelationKind = 'refund_of' | 'fee_for'

export type AppliedTransactionRelation = {
  kind: TransactionRelationKind
  targetTransactionId: number
}

export type RecordRelatedExpenseResult = {
  action: 'created'
  transaction: IncomeExpenseTransaction
  relation: AppliedTransactionRelation | null
  previousBalanceMinor: number
  resultingBalanceMinor: number
}

export type TransactionSnapshot = {
  id: number
  kind: 'income' | 'expense' | 'transfer' | 'adjustment'
  occurredOn: string
  memo: string | null
  accountId: number | null
  amountMinor: number | null
  sourceAccountId: number | null
  sourceAmountMinor: number | null
  destinationAccountId: number | null
  destinationAmountMinor: number | null
}

export type RelatedTransaction = {
  relationKind: TransactionRelationKind
  direction: 'incoming' | 'outgoing'
  transaction: TransactionSnapshot
}

export type TransactionRelationInspection = {
  transaction: TransactionSnapshot
  relatedTransactions: RelatedTransaction[]
  requiresConfirmationBeforeMultiTransactionChange: boolean
}

type AccountRow = {
  id: number
  name: string
  nature: AccountNature
  currency: string
  archived_at: string | null
  balance_minor: number
}

type TransactionSnapshotRow = {
  id: number
  kind: TransactionSnapshot['kind']
  occurred_on: string
  memo: string | null
  account_id: number | null
  amount_minor: number | null
  source_account_id: number | null
  source_amount_minor: number | null
  destination_account_id: number | null
  destination_amount_minor: number | null
}

type RelationRow = {
  relation_kind: TransactionRelationKind
  source_transaction_id: number
  target_transaction_id: number
}

export function recordRefund(
  vaultPath: string,
  request: RefundRequest,
): RecordRelatedExpenseResult {
  const originalExpenseId =
    request.originalExpenseId === undefined || request.originalExpenseId === null
      ? null
      : validateTransactionId(request.originalExpenseId, 'Original Expense')

  return recordRelatedExpense(vaultPath, {
    accountId: request.accountId,
    amountMinor: -validatePositiveAmount(request.amountMinor, 'Refund'),
    occurredOn: request.occurredOn,
    memo: request.memo,
    relation:
      originalExpenseId === null
        ? null
        : {
            kind: 'refund_of',
            targetTransactionId: originalExpenseId,
            requiredTargetKind: 'positive Expense',
          },
  })
}

export function recordTransferFee(
  vaultPath: string,
  request: TransferFeeRequest,
): RecordRelatedExpenseResult {
  const transferId = validateTransactionId(request.transferId, 'Transfer')

  return recordRelatedExpense(vaultPath, {
    accountId: request.accountId,
    amountMinor: validatePositiveAmount(request.amountMinor, 'Transfer fee'),
    occurredOn: request.occurredOn,
    memo: request.memo,
    relation: {
      kind: 'fee_for',
      targetTransactionId: transferId,
      requiredTargetKind: 'Transfer',
    },
  })
}

export function inspectTransactionRelations(
  vaultPath: string,
  transactionId: number,
): TransactionRelationInspection {
  const validatedTransactionId = validateTransactionId(transactionId, 'Transaction')

  return withVaultDatabase(vaultPath, (database) => {
    const transaction = readTransactionSnapshot(database, validatedTransactionId)
    const rows = database
      .prepare(
        `SELECT relation_kind, source_transaction_id, target_transaction_id
         FROM transaction_relations
         WHERE source_transaction_id = ? OR target_transaction_id = ?
         ORDER BY id`,
      )
      .all(validatedTransactionId, validatedTransactionId) as RelationRow[]
    const relatedTransactions = rows.map((row) => {
      const outgoing = row.source_transaction_id === validatedTransactionId
      const relatedTransactionId = outgoing ? row.target_transaction_id : row.source_transaction_id

      return {
        relationKind: row.relation_kind,
        direction: outgoing ? ('outgoing' as const) : ('incoming' as const),
        transaction: readTransactionSnapshot(database, relatedTransactionId),
      }
    })

    return {
      transaction,
      relatedTransactions,
      requiresConfirmationBeforeMultiTransactionChange: relatedTransactions.length > 0,
    }
  })
}

type RelatedExpenseInput = {
  accountId: number
  amountMinor: number
  occurredOn: string
  memo?: string | null | undefined
  relation: {
    kind: TransactionRelationKind
    targetTransactionId: number
    requiredTargetKind: 'positive Expense' | 'Transfer'
  } | null
}

function recordRelatedExpense(
  vaultPath: string,
  input: RelatedExpenseInput,
): RecordRelatedExpenseResult {
  const accountId = validateAccountId(input.accountId)
  const occurredOn = validateCalendarDate(input.occurredOn)
  const memo = normalizeMemo(input.memo)

  return withVaultDatabase(vaultPath, (database) =>
    runMutation(database, () => {
      const account = readActiveAccount(database, accountId)

      if (input.relation !== null) {
        validateRelationTarget(database, input.relation)
      }

      const transactionId = Number(
        database
          .prepare(
            `INSERT INTO transactions (kind, occurred_on, account_id, amount_minor, memo)
             VALUES ('expense', ?, ?, ?, ?)`,
          )
          .run(occurredOn, accountId, input.amountMinor, memo).lastInsertRowid,
      )
      const relation =
        input.relation === null
          ? null
          : {
              kind: input.relation.kind,
              targetTransactionId: input.relation.targetTransactionId,
            }

      if (relation !== null) {
        database
          .prepare(
            `INSERT INTO transaction_relations (
               relation_kind,
               source_transaction_id,
               target_transaction_id
             ) VALUES (?, ?, ?)`,
          )
          .run(relation.kind, transactionId, relation.targetTransactionId)
      }

      const transaction = readIncomeExpenseTransactionFromDatabase(database, transactionId)
      const result = {
        action: 'created' as const,
        transaction,
        relation,
        previousBalanceMinor: account.balance_minor,
        resultingBalanceMinor: readAccountBalance(database, accountId),
      }

      insertChangeRecord(database, 'transaction', String(transactionId), 'created', result)

      return result
    }),
  )
}

function validateAccountId(accountId: number): number {
  if (!Number.isSafeInteger(accountId) || accountId <= 0) {
    throw new Error('Account ID must be a positive integer')
  }

  return accountId
}

function validateTransactionId(transactionId: number, label: string): number {
  if (!Number.isSafeInteger(transactionId) || transactionId <= 0) {
    throw new Error(`${label} Transaction ID must be a positive integer`)
  }

  return transactionId
}

function validatePositiveAmount(amountMinor: number, label: 'Refund' | 'Transfer fee'): number {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw new Error(`${label} amount must be positive integer minor units`)
  }

  return amountMinor
}

function validateRelationTarget(
  database: DatabaseSync,
  relation: NonNullable<RelatedExpenseInput['relation']>,
): void {
  const target = database
    .prepare('SELECT kind, amount_minor FROM transactions WHERE id = ?')
    .get(relation.targetTransactionId) as { kind: string; amount_minor: number | null } | undefined

  if (!target) {
    throw new Error(
      `Related ${relation.requiredTargetKind} ${relation.targetTransactionId} is missing`,
    )
  }

  const valid =
    relation.kind === 'refund_of'
      ? target.kind === 'expense' && target.amount_minor !== null && target.amount_minor > 0
      : target.kind === 'transfer'

  if (!valid) {
    throw new Error(
      `Transaction ${relation.targetTransactionId} is not the required ` +
        `${relation.requiredTargetKind} for ${relation.kind}`,
    )
  }
}

function readActiveAccount(database: DatabaseSync, accountId: number): AccountRow {
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

  if (row.archived_at !== null) {
    throw new Error(`Archived Account ${row.id} ("${row.name}") cannot receive new Transactions`)
  }

  return row
}

function readAccountBalance(database: DatabaseSync, accountId: number): number {
  const row = database
    .prepare('SELECT balance_minor FROM account_balances WHERE account_id = ?')
    .get(accountId) as { balance_minor: number } | undefined

  if (!row) {
    throw new Error(`Account ${accountId} does not exist`)
  }

  return row.balance_minor
}

function readTransactionSnapshot(
  database: DatabaseSync,
  transactionId: number,
): TransactionSnapshot {
  const row = database
    .prepare(
      `SELECT
         id,
         kind,
         occurred_on,
         memo,
         account_id,
         amount_minor,
         source_account_id,
         source_amount_minor,
         destination_account_id,
         destination_amount_minor
       FROM transactions
       WHERE id = ?`,
    )
    .get(transactionId) as TransactionSnapshotRow | undefined

  if (!row) {
    throw new Error(`Transaction ${transactionId} does not exist`)
  }

  return {
    id: row.id,
    kind: row.kind,
    occurredOn: row.occurred_on,
    memo: row.memo,
    accountId: row.account_id,
    amountMinor: row.amount_minor,
    sourceAccountId: row.source_account_id,
    sourceAmountMinor: row.source_amount_minor,
    destinationAccountId: row.destination_account_id,
    destinationAmountMinor: row.destination_amount_minor,
  }
}
