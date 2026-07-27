import type { DatabaseSync } from 'node:sqlite'
import type { AccountNature } from './accounts.js'
import { insertChangeRecord, runMutation } from './persistence.js'
import { normalizeMemo, type TransactionAccount, validateCalendarDate } from './transactions.js'
import { withVaultDatabase } from './vault.js'

export type AdjustmentRequest = {
  accountId: number
  occurredOn: string
  amountMinor?: number | undefined
  targetBalanceMinor?: number | undefined
  memo?: string | null | undefined
}

export type AdjustmentTransaction = {
  id: number
  kind: 'adjustment'
  occurredOn: string
  account: TransactionAccount
  amountMinor: number
  memo: string | null
}

export type RecordAdjustmentResult = {
  action: 'created'
  transaction: AdjustmentTransaction
  previousBalanceMinor: number
  adjustmentAmountMinor: number
  resultingBalanceMinor: number
  requestedTargetBalanceMinor: number | null
}

type AccountRow = {
  id: number
  name: string
  nature: AccountNature
  currency: string
  archived_at: string | null
  balance_minor: number
}

export function recordAdjustment(
  vaultPath: string,
  request: AdjustmentRequest,
): RecordAdjustmentResult {
  const accountId = validateAccountId(request.accountId)
  const occurredOn = validateCalendarDate(request.occurredOn)
  const memo = normalizeMemo(request.memo)
  const hasAmount = request.amountMinor !== undefined
  const hasTarget = request.targetBalanceMinor !== undefined

  if (hasAmount === hasTarget) {
    throw new Error('Provide exactly one of Adjustment amount or target Account balance')
  }

  const requestedAmount =
    request.amountMinor === undefined ? undefined : validateSignedAmount(request.amountMinor)
  const targetBalance =
    request.targetBalanceMinor === undefined
      ? undefined
      : validateTargetBalance(request.targetBalanceMinor)

  return withVaultDatabase(vaultPath, (database) =>
    runMutation(database, () => {
      const account = readAccount(database, accountId)

      if (account.archived_at !== null) {
        throw new Error(
          `Archived Account ${account.id} ("${account.name}") cannot receive new Transactions`,
        )
      }

      const adjustmentAmount =
        targetBalance === undefined ? requestedAmount : targetBalance - account.balance_minor

      if (adjustmentAmount === undefined) {
        throw new Error('Adjustment amount is missing')
      }

      if (!Number.isSafeInteger(adjustmentAmount)) {
        throw new Error('Calculated Adjustment exceeds integer-safe minor units')
      }

      if (adjustmentAmount === 0) {
        throw new Error(
          `Account ${account.id} ("${account.name}") already has the requested balance ` +
            `${account.balance_minor} ${account.currency}`,
        )
      }

      const transactionId = Number(
        database
          .prepare(
            `INSERT INTO transactions (kind, occurred_on, account_id, amount_minor, memo)
             VALUES ('adjustment', ?, ?, ?, ?)`,
          )
          .run(occurredOn, accountId, adjustmentAmount, memo).lastInsertRowid,
      )
      const resultingBalanceMinor = readAccountBalance(database, accountId)
      const transaction: AdjustmentTransaction = {
        id: transactionId,
        kind: 'adjustment',
        occurredOn,
        account: mapTransactionAccount(account),
        amountMinor: adjustmentAmount,
        memo,
      }
      const result = {
        action: 'created' as const,
        transaction,
        previousBalanceMinor: account.balance_minor,
        adjustmentAmountMinor: adjustmentAmount,
        resultingBalanceMinor,
        requestedTargetBalanceMinor: targetBalance ?? null,
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

function validateSignedAmount(amountMinor: number): number {
  if (!Number.isSafeInteger(amountMinor) || amountMinor === 0) {
    throw new Error('Adjustment amount must be nonzero integer minor units')
  }

  return amountMinor
}

function validateTargetBalance(targetBalanceMinor: number): number {
  if (!Number.isSafeInteger(targetBalanceMinor)) {
    throw new Error('Target Account balance must use integer minor units')
  }

  return targetBalanceMinor
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
    .prepare('SELECT balance_minor FROM account_balances WHERE account_id = ?')
    .get(accountId) as { balance_minor: number } | undefined

  if (!row) {
    throw new Error(`Account ${accountId} does not exist`)
  }

  return row.balance_minor
}

function mapTransactionAccount(account: AccountRow): TransactionAccount {
  return {
    id: account.id,
    name: account.name,
    nature: account.nature,
    currency: account.currency,
    archived: account.archived_at !== null,
  }
}
