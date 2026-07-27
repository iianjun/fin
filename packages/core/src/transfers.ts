import type { DatabaseSync } from 'node:sqlite'
import type { AccountNature } from './accounts.js'
import { insertChangeRecord, runMutation } from './persistence.js'
import { normalizeMemo, type TransactionAccount, validateCalendarDate } from './transactions.js'
import { withVaultDatabase } from './vault.js'

export type TransferRequest = {
  sourceAccountId: number
  sourceAmountMinor: number
  destinationAccountId: number
  destinationAmountMinor: number
  occurredOn: string
  memo?: string | null | undefined
}

export type TransferEndpoint = {
  account: TransactionAccount
  amountMinor: number
}

export type TransferTransaction = {
  id: number
  kind: 'transfer'
  occurredOn: string
  source: TransferEndpoint
  destination: TransferEndpoint
  memo: string | null
}

export type RecordTransferResult = {
  action: 'created'
  transaction: TransferTransaction
  sourcePreviousBalanceMinor: number
  sourceResultingBalanceMinor: number
  destinationPreviousBalanceMinor: number
  destinationResultingBalanceMinor: number
}

type AccountRow = {
  id: number
  name: string
  nature: AccountNature
  currency: string
  archived_at: string | null
  balance_minor: number
}

export function recordTransfer(vaultPath: string, request: TransferRequest): RecordTransferResult {
  const sourceAccountId = validateAccountId(request.sourceAccountId, 'Source')
  const destinationAccountId = validateAccountId(request.destinationAccountId, 'Destination')
  const sourceAmountMinor = validateTransferAmount(request.sourceAmountMinor, 'Source')
  const destinationAmountMinor = validateTransferAmount(
    request.destinationAmountMinor,
    'Destination',
  )
  const occurredOn = validateCalendarDate(request.occurredOn)
  const memo = normalizeMemo(request.memo)

  if (sourceAccountId === destinationAccountId) {
    throw new Error('Transfer source and destination Accounts must be different')
  }

  return withVaultDatabase(vaultPath, (database) =>
    runMutation(database, () => {
      const sourceAccount = readActiveAccount(database, sourceAccountId, 'Source')
      const destinationAccount = readActiveAccount(database, destinationAccountId, 'Destination')

      if (
        sourceAccount.currency === destinationAccount.currency &&
        sourceAmountMinor !== destinationAmountMinor
      ) {
        throw new Error(
          `Same-currency Transfer amounts must match: source ${sourceAmountMinor} ` +
            `${sourceAccount.currency}, destination ${destinationAmountMinor} ` +
            `${destinationAccount.currency}`,
        )
      }

      const transactionId = Number(
        database
          .prepare(
            `INSERT INTO transactions (
               kind,
               occurred_on,
               source_account_id,
               source_amount_minor,
               destination_account_id,
               destination_amount_minor,
               memo
             ) VALUES ('transfer', ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            occurredOn,
            sourceAccountId,
            sourceAmountMinor,
            destinationAccountId,
            destinationAmountMinor,
            memo,
          ).lastInsertRowid,
      )
      const transaction: TransferTransaction = {
        id: transactionId,
        kind: 'transfer',
        occurredOn,
        source: {
          account: mapTransactionAccount(sourceAccount),
          amountMinor: sourceAmountMinor,
        },
        destination: {
          account: mapTransactionAccount(destinationAccount),
          amountMinor: destinationAmountMinor,
        },
        memo,
      }
      const result = {
        action: 'created' as const,
        transaction,
        sourcePreviousBalanceMinor: sourceAccount.balance_minor,
        sourceResultingBalanceMinor: readAccountBalance(database, sourceAccountId),
        destinationPreviousBalanceMinor: destinationAccount.balance_minor,
        destinationResultingBalanceMinor: readAccountBalance(database, destinationAccountId),
      }

      insertChangeRecord(database, 'transaction', String(transactionId), 'created', result)

      return result
    }),
  )
}

function validateAccountId(accountId: number, role: 'Source' | 'Destination'): number {
  if (!Number.isSafeInteger(accountId) || accountId <= 0) {
    throw new Error(`${role} Account ID must be a positive integer`)
  }

  return accountId
}

function validateTransferAmount(amountMinor: number, role: 'Source' | 'Destination'): number {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw new Error(`${role} Transfer amount must be positive integer minor units`)
  }

  return amountMinor
}

function readActiveAccount(
  database: DatabaseSync,
  accountId: number,
  role: 'Source' | 'Destination',
): AccountRow {
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
    throw new Error(`${role} Account ${accountId} does not exist`)
  }

  if (row.archived_at !== null) {
    throw new Error(
      `Archived ${role} Account ${row.id} ("${row.name}") cannot receive new Transactions`,
    )
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
