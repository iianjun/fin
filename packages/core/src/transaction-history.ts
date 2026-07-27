import type { DatabaseSync } from 'node:sqlite'
import type { AccountNature } from './accounts.js'
import type { CategoryAssignmentInput, CategoryAssignmentOrigin } from './classifications.js'
import { insertChangeRecord, runMutation } from './persistence.js'
import type { AppliedTransactionRelation, TransactionRelationKind } from './related-expenses.js'
import { normalizeMemo, type TransactionAccount, validateCalendarDate } from './transactions.js'
import { withVaultDatabase } from './vault.js'

export type TransactionKind = 'income' | 'expense' | 'transfer' | 'adjustment'

export type TransactionCategoryAssignmentState = {
  categoryId: number
  categoryPath: string
  amountMinor: number
  origin: CategoryAssignmentOrigin
}

export type RelatedTransactionReference = {
  id: number
  kind: TransactionKind
  occurredOn: string
  memo: string | null
}

export type TransactionRelationReference = {
  relationKind: TransactionRelationKind
  direction: 'incoming' | 'outgoing'
  relatedTransaction: RelatedTransactionReference
}

type TransactionStateBase = {
  id: number
  occurredOn: string
  memo: string | null
  relations: TransactionRelationReference[]
}

export type IncomeExpenseTransactionState = TransactionStateBase & {
  kind: 'income' | 'expense'
  account: TransactionAccount
  amountMinor: number
  assignments: TransactionCategoryAssignmentState[]
}

export type AdjustmentTransactionState = TransactionStateBase & {
  kind: 'adjustment'
  account: TransactionAccount
  amountMinor: number
}

export type TransferTransactionState = TransactionStateBase & {
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

export type TransactionState =
  | IncomeExpenseTransactionState
  | AdjustmentTransactionState
  | TransferTransactionState

export type IncomeExpenseReplacement = {
  kind: 'income' | 'expense'
  accountId: number
  amountMinor: number
  occurredOn: string
  memo?: string | null | undefined
  assignments?: CategoryAssignmentInput[] | undefined
  relation?: AppliedTransactionRelation | null | undefined
}

export type AdjustmentReplacement = {
  kind: 'adjustment'
  accountId: number
  amountMinor: number
  occurredOn: string
  memo?: string | null | undefined
}

export type TransferReplacement = {
  kind: 'transfer'
  sourceAccountId: number
  sourceAmountMinor: number
  destinationAccountId: number
  destinationAmountMinor: number
  occurredOn: string
  memo?: string | null | undefined
}

export type TransactionReplacement =
  | IncomeExpenseReplacement
  | AdjustmentReplacement
  | TransferReplacement

export type EditTransactionRequest = {
  transactionId: number
  replacement: TransactionReplacement
}

export type AccountBalanceChange = {
  accountId: number
  currency: string
  previousBalanceMinor: number
  resultingBalanceMinor: number
}

export type EditTransactionResult = {
  action: 'updated'
  previousTransaction: TransactionState
  transaction: TransactionState
  balanceChanges: AccountBalanceChange[]
  relatedTransactions: TransactionRelationReference[]
  requiresConfirmationBeforeMultiTransactionChange: boolean
}

export type DeleteTransactionResult = {
  action: 'deleted'
  transaction: TransactionState
  balanceChanges: AccountBalanceChange[]
  relatedTransactions: TransactionRelationReference[]
  requiresConfirmationBeforeMultiTransactionChange: boolean
}

export type RecreateTransactionResult = {
  action: 'created'
  recreatedFromChangeRecordId: number
  deletedTransactionId: number
  transaction: TransactionState
  balanceChanges: AccountBalanceChange[]
  omittedIncomingRelations: TransactionRelationReference[]
}

export type TransactionChangeRecord = {
  id: number
  transactionId: number
  action: 'created' | 'updated' | 'deleted'
  payload: Record<string, unknown>
  recordedAt: string
  description: string
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
}

type RelationRow = {
  relation_kind: TransactionRelationKind
  source_transaction_id: number
  target_transaction_id: number
  related_id: number
  related_kind: TransactionKind
  related_occurred_on: string
  related_memo: string | null
}

type AccountBalanceRow = {
  account_id: number
  currency: string
  balance_minor: number
}

type BalanceEffectRow = {
  account_id: number
  amount_minor: number
}

type ChangeRecordRow = {
  id: number
  entity_id: string
  action: TransactionChangeRecord['action']
  payload: string
  recorded_at: string
}

export function editTransaction(
  vaultPath: string,
  request: EditTransactionRequest,
): EditTransactionResult {
  const transactionId = validatePositiveId(request.transactionId, 'Transaction')
  const replacement = validateReplacement(request.replacement)

  return withVaultDatabase(vaultPath, (database) =>
    runMutation(database, () => {
      const previousTransaction = readTransactionState(database, transactionId)

      if (previousTransaction.kind !== replacement.kind) {
        throw new Error(
          `Transaction ${transactionId} is ${previousTransaction.kind} and cannot be edited ` +
            `as ${replacement.kind}`,
        )
      }

      const affectedAccountIds = uniqueAccountIds([
        ...readTransactionAccountIds(previousTransaction),
        ...readReplacementAccountIds(replacement),
      ])
      const previousBalances = readAccountBalances(database, affectedAccountIds)

      if (
        (replacement.kind === 'income' || replacement.kind === 'expense') &&
        replacement.assignments !== undefined
      ) {
        database
          .prepare('DELETE FROM category_assignments WHERE transaction_id = ?')
          .run(transactionId)
      }

      if (
        (replacement.kind === 'income' || replacement.kind === 'expense') &&
        replacement.relation !== undefined
      ) {
        database
          .prepare('DELETE FROM transaction_relations WHERE source_transaction_id = ?')
          .run(transactionId)
      }

      updateTransactionRow(database, transactionId, replacement)

      if (
        (replacement.kind === 'income' || replacement.kind === 'expense') &&
        replacement.assignments !== undefined
      ) {
        insertCategoryAssignments(database, transactionId, replacement.assignments)
      }

      if (
        (replacement.kind === 'income' || replacement.kind === 'expense') &&
        replacement.relation !== undefined &&
        replacement.relation !== null
      ) {
        insertTransactionRelation(database, transactionId, replacement.relation)
      }

      const transaction = readTransactionState(database, transactionId)
      const result: EditTransactionResult = {
        action: 'updated',
        previousTransaction,
        transaction,
        balanceChanges: compareBalances(
          previousBalances,
          readAccountBalances(database, affectedAccountIds),
        ),
        relatedTransactions: previousTransaction.relations,
        requiresConfirmationBeforeMultiTransactionChange: previousTransaction.relations.length > 0,
      }

      insertChangeRecord(database, 'transaction', String(transactionId), 'updated', result)

      return result
    }),
  )
}

export function deleteTransaction(
  vaultPath: string,
  transactionId: number,
): DeleteTransactionResult {
  const validatedTransactionId = validatePositiveId(transactionId, 'Transaction')

  return withVaultDatabase(vaultPath, (database) =>
    runMutation(database, () => {
      const transaction = readTransactionState(database, validatedTransactionId)
      const balanceChanges = predictDeletionBalanceChanges(database, validatedTransactionId)
      const result: DeleteTransactionResult = {
        action: 'deleted',
        transaction,
        balanceChanges,
        relatedTransactions: transaction.relations,
        requiresConfirmationBeforeMultiTransactionChange: transaction.relations.length > 0,
      }

      insertChangeRecord(database, 'transaction', String(validatedTransactionId), 'deleted', result)
      database.prepare('DELETE FROM transactions WHERE id = ?').run(validatedTransactionId)
      assertBalanceChangesApplied(database, balanceChanges)

      return result
    }),
  )
}

export function recreateTransaction(
  vaultPath: string,
  deletionChangeRecordId: number,
): RecreateTransactionResult {
  const validatedChangeRecordId = validatePositiveId(deletionChangeRecordId, 'Change Record')

  return withVaultDatabase(vaultPath, (database) =>
    runMutation(database, () => {
      const deletedTransaction = readDeletedTransaction(database, validatedChangeRecordId)
      const affectedAccountIds = readTransactionAccountIds(deletedTransaction)
      const previousBalances = readAccountBalances(database, affectedAccountIds)
      const transactionId = insertTransactionFromState(database, deletedTransaction)
      const transaction = readTransactionState(database, transactionId)
      const result: RecreateTransactionResult = {
        action: 'created',
        recreatedFromChangeRecordId: validatedChangeRecordId,
        deletedTransactionId: deletedTransaction.id,
        transaction,
        balanceChanges: compareBalances(
          previousBalances,
          readAccountBalances(database, affectedAccountIds),
        ),
        omittedIncomingRelations: deletedTransaction.relations.filter(
          (relation) => relation.direction === 'incoming',
        ),
      }

      insertChangeRecord(database, 'transaction', String(transactionId), 'created', result)

      return result
    }),
  )
}

export function listTransactionChangeRecords(
  vaultPath: string,
  transactionId?: number | undefined,
): TransactionChangeRecord[] {
  const validatedTransactionId =
    transactionId === undefined ? undefined : validatePositiveId(transactionId, 'Transaction')

  return withVaultDatabase(vaultPath, (database) => {
    const rows =
      validatedTransactionId === undefined
        ? (database
            .prepare(
              `SELECT id, entity_id, action, payload, recorded_at
               FROM change_records
               WHERE entity_type = 'transaction'
               ORDER BY id`,
            )
            .all() as ChangeRecordRow[])
        : (database
            .prepare(
              `SELECT id, entity_id, action, payload, recorded_at
               FROM change_records
               WHERE entity_type = 'transaction' AND entity_id = ?
               ORDER BY id`,
            )
            .all(String(validatedTransactionId)) as ChangeRecordRow[])

    return rows.map(mapChangeRecord)
  })
}

function validateReplacement(replacement: TransactionReplacement): TransactionReplacement {
  const occurredOn = validateCalendarDate(replacement.occurredOn)
  const memo = normalizeMemo(replacement.memo)

  if (replacement.kind === 'transfer') {
    const sourceAccountId = validatePositiveId(replacement.sourceAccountId, 'Source Account')
    const destinationAccountId = validatePositiveId(
      replacement.destinationAccountId,
      'Destination Account',
    )

    if (sourceAccountId === destinationAccountId) {
      throw new Error('Transfer source and destination Accounts must be different')
    }

    return {
      ...replacement,
      sourceAccountId,
      sourceAmountMinor: validatePositiveAmount(replacement.sourceAmountMinor, 'Source Transfer'),
      destinationAccountId,
      destinationAmountMinor: validatePositiveAmount(
        replacement.destinationAmountMinor,
        'Destination Transfer',
      ),
      occurredOn,
      memo,
    }
  }

  const amountMinor = validateSignedAmount(replacement.amountMinor, replacement.kind)
  const accountId = validatePositiveId(replacement.accountId, 'Account')

  if (replacement.kind === 'adjustment') {
    return {
      ...replacement,
      accountId,
      amountMinor,
      occurredOn,
      memo,
    }
  }

  const assignments =
    replacement.assignments === undefined
      ? undefined
      : replacement.assignments.map(validateAssignmentInput)
  const relation =
    replacement.relation === undefined
      ? undefined
      : replacement.relation === null
        ? null
        : validateRelation(replacement.relation)

  return {
    ...replacement,
    accountId,
    amountMinor,
    occurredOn,
    memo,
    assignments,
    relation,
  }
}

function validateAssignmentInput(assignment: CategoryAssignmentInput): CategoryAssignmentInput {
  return {
    categoryId: validatePositiveId(assignment.categoryId, 'Category'),
    amountMinor: validateNonzeroInteger(assignment.amountMinor, 'Category Assignment amount'),
    origin: validateAssignmentOrigin(assignment.origin),
  }
}

function validateAssignmentOrigin(origin: CategoryAssignmentOrigin): CategoryAssignmentOrigin {
  if (origin !== 'explicit' && origin !== 'inferred') {
    throw new Error('Category Assignment origin must be "explicit" or "inferred"')
  }

  return origin
}

function validateRelation(relation: AppliedTransactionRelation): AppliedTransactionRelation {
  if (relation.kind !== 'refund_of' && relation.kind !== 'fee_for') {
    throw new Error('Transaction relation kind must be "refund_of" or "fee_for"')
  }

  return {
    kind: relation.kind,
    targetTransactionId: validatePositiveId(relation.targetTransactionId, 'Related Transaction'),
  }
}

function validatePositiveId(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} ID must be a positive integer`)
  }

  return value
}

function validateSignedAmount(value: number, kind: 'income' | 'expense' | 'adjustment'): number {
  const amount = validateNonzeroInteger(value, `${capitalize(kind)} amount`)

  if (kind === 'income' && amount < 0) {
    throw new Error('Income amount must be positive integer minor units')
  }

  return amount
}

function validatePositiveAmount(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} amount must be positive integer minor units`)
  }

  return value
}

function validateNonzeroInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value === 0) {
    throw new Error(`${label} must be nonzero integer minor units`)
  }

  return value
}

function updateTransactionRow(
  database: DatabaseSync,
  transactionId: number,
  replacement: TransactionReplacement,
): void {
  if (replacement.kind === 'transfer') {
    database
      .prepare(
        `UPDATE transactions
         SET
           kind = 'transfer',
           occurred_on = ?,
           account_id = NULL,
           amount_minor = NULL,
           source_account_id = ?,
           source_amount_minor = ?,
           destination_account_id = ?,
           destination_amount_minor = ?,
           memo = ?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?`,
      )
      .run(
        replacement.occurredOn,
        replacement.sourceAccountId,
        replacement.sourceAmountMinor,
        replacement.destinationAccountId,
        replacement.destinationAmountMinor,
        replacement.memo ?? null,
        transactionId,
      )
    return
  }

  database
    .prepare(
      `UPDATE transactions
       SET
         kind = ?,
         occurred_on = ?,
         account_id = ?,
         amount_minor = ?,
         source_account_id = NULL,
         source_amount_minor = NULL,
         destination_account_id = NULL,
         destination_amount_minor = NULL,
         memo = ?,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ?`,
    )
    .run(
      replacement.kind,
      replacement.occurredOn,
      replacement.accountId,
      replacement.amountMinor,
      replacement.memo ?? null,
      transactionId,
    )
}

function insertCategoryAssignments(
  database: DatabaseSync,
  transactionId: number,
  assignments: CategoryAssignmentInput[],
): void {
  const statement = database.prepare(
    `INSERT INTO category_assignments (
       transaction_id,
       category_id,
       amount_minor,
       origin
     ) VALUES (?, ?, ?, ?)`,
  )

  for (const assignment of assignments) {
    statement.run(transactionId, assignment.categoryId, assignment.amountMinor, assignment.origin)
  }
}

function insertTransactionRelation(
  database: DatabaseSync,
  transactionId: number,
  relation: AppliedTransactionRelation,
): void {
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

function readTransactionState(database: DatabaseSync, transactionId: number): TransactionState {
  const row = database
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
       WHERE transactions.id = ?`,
    )
    .get(transactionId) as TransactionRow | undefined

  if (!row) {
    throw new Error(`Transaction ${transactionId} does not exist`)
  }

  const base = {
    id: row.id,
    occurredOn: row.occurred_on,
    memo: row.memo,
    relations: readTransactionRelations(database, transactionId),
  }

  if (row.kind === 'transfer') {
    return {
      ...base,
      kind: 'transfer',
      source: {
        account: mapJoinedAccount(row, 'source'),
        amountMinor: requireNumber(row.source_amount_minor, 'Transfer source amount'),
      },
      destination: {
        account: mapJoinedAccount(row, 'destination'),
        amountMinor: requireNumber(row.destination_amount_minor, 'Transfer destination amount'),
      },
    }
  }

  const account = mapJoinedAccount(row, 'account')
  const amountMinor = requireNumber(row.amount_minor, `${capitalize(row.kind)} amount`)

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
    assignments: readCategoryAssignments(database, transactionId),
  }
}

function mapJoinedAccount(
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

function readCategoryAssignments(
  database: DatabaseSync,
  transactionId: number,
): TransactionCategoryAssignmentState[] {
  const rows = database
    .prepare(
      `SELECT
         category_assignments.category_id,
         category_paths.path AS category_path,
         category_assignments.amount_minor,
         category_assignments.origin
       FROM category_assignments
       JOIN category_paths ON category_paths.id = category_assignments.category_id
       WHERE category_assignments.transaction_id = ?
       ORDER BY category_assignments.id`,
    )
    .all(transactionId) as AssignmentRow[]

  return rows.map((row) => ({
    categoryId: row.category_id,
    categoryPath: row.category_path,
    amountMinor: row.amount_minor,
    origin: row.origin,
  }))
}

function readTransactionRelations(
  database: DatabaseSync,
  transactionId: number,
): TransactionRelationReference[] {
  const rows = database
    .prepare(
      `SELECT
         transaction_relations.relation_kind,
         transaction_relations.source_transaction_id,
         transaction_relations.target_transaction_id,
         related.id AS related_id,
         related.kind AS related_kind,
         related.occurred_on AS related_occurred_on,
         related.memo AS related_memo
       FROM transaction_relations
       JOIN transactions AS related
         ON related.id = CASE
           WHEN transaction_relations.source_transaction_id = ?
             THEN transaction_relations.target_transaction_id
           ELSE transaction_relations.source_transaction_id
         END
       WHERE
         transaction_relations.source_transaction_id = ?
         OR transaction_relations.target_transaction_id = ?
       ORDER BY transaction_relations.id`,
    )
    .all(transactionId, transactionId, transactionId) as RelationRow[]

  return rows.map((row) => ({
    relationKind: row.relation_kind,
    direction: row.source_transaction_id === transactionId ? 'outgoing' : 'incoming',
    relatedTransaction: {
      id: row.related_id,
      kind: row.related_kind,
      occurredOn: row.related_occurred_on,
      memo: row.related_memo,
    },
  }))
}

function readTransactionAccountIds(transaction: TransactionState): number[] {
  return transaction.kind === 'transfer'
    ? [transaction.source.account.id, transaction.destination.account.id]
    : [transaction.account.id]
}

function readReplacementAccountIds(replacement: TransactionReplacement): number[] {
  return replacement.kind === 'transfer'
    ? [replacement.sourceAccountId, replacement.destinationAccountId]
    : [replacement.accountId]
}

function uniqueAccountIds(accountIds: number[]): number[] {
  return [...new Set(accountIds)].sort((left, right) => left - right)
}

function readAccountBalances(database: DatabaseSync, accountIds: number[]): AccountBalanceRow[] {
  const statement = database.prepare(
    `SELECT
       accounts.id AS account_id,
       accounts.currency,
       account_balances.balance_minor
     FROM accounts
     JOIN account_balances ON account_balances.account_id = accounts.id
     WHERE accounts.id = ?`,
  )

  return accountIds.map((accountId) => {
    const row = statement.get(accountId) as AccountBalanceRow | undefined

    if (!row) {
      throw new Error(`Account ${accountId} does not exist`)
    }

    return row
  })
}

function compareBalances(
  previousBalances: AccountBalanceRow[],
  resultingBalances: AccountBalanceRow[],
): AccountBalanceChange[] {
  const resultingByAccountId = new Map(
    resultingBalances.map((balance) => [balance.account_id, balance]),
  )

  return previousBalances.map((previous) => {
    const resulting = resultingByAccountId.get(previous.account_id)

    if (!resulting) {
      throw new Error(`Resulting balance for Account ${previous.account_id} is missing`)
    }

    return {
      accountId: previous.account_id,
      currency: previous.currency,
      previousBalanceMinor: previous.balance_minor,
      resultingBalanceMinor: resulting.balance_minor,
    }
  })
}

function predictDeletionBalanceChanges(
  database: DatabaseSync,
  transactionId: number,
): AccountBalanceChange[] {
  const effects = database
    .prepare(
      `SELECT account_id, amount_minor
       FROM account_balance_effects
       WHERE transaction_id = ?
       ORDER BY account_id`,
    )
    .all(transactionId) as BalanceEffectRow[]
  const balances = readAccountBalances(
    database,
    effects.map((effect) => effect.account_id),
  )
  const effectByAccountId = new Map(
    effects.map((effect) => [effect.account_id, effect.amount_minor]),
  )

  return balances.map((balance) => ({
    accountId: balance.account_id,
    currency: balance.currency,
    previousBalanceMinor: balance.balance_minor,
    resultingBalanceMinor: balance.balance_minor - (effectByAccountId.get(balance.account_id) ?? 0),
  }))
}

function assertBalanceChangesApplied(
  database: DatabaseSync,
  changes: AccountBalanceChange[],
): void {
  const balances = readAccountBalances(
    database,
    changes.map((change) => change.accountId),
  )

  for (const change of changes) {
    const balance = balances.find((candidate) => candidate.account_id === change.accountId)

    if (!balance || balance.balance_minor !== change.resultingBalanceMinor) {
      throw new Error(
        `Deleting Transaction produced an unexpected Account ${change.accountId} balance`,
      )
    }
  }
}

function readDeletedTransaction(database: DatabaseSync, changeRecordId: number): TransactionState {
  const row = database
    .prepare(
      `SELECT entity_id, payload
       FROM change_records
       WHERE id = ? AND entity_type = 'transaction' AND action = 'deleted'`,
    )
    .get(changeRecordId) as { entity_id: string; payload: string } | undefined

  if (!row) {
    throw new Error(`Deleted Transaction Change Record ${changeRecordId} does not exist`)
  }

  const payload = parsePayload(row.payload, changeRecordId)
  const transaction = payload.transaction

  if (!isTransactionState(transaction) || String(transaction.id) !== row.entity_id) {
    throw new Error(`Change Record ${changeRecordId} has invalid Transaction recreation data`)
  }

  return transaction
}

function insertTransactionFromState(
  database: DatabaseSync,
  deletedTransaction: TransactionState,
): number {
  const transactionId =
    deletedTransaction.kind === 'transfer'
      ? Number(
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
              deletedTransaction.occurredOn,
              deletedTransaction.source.account.id,
              deletedTransaction.source.amountMinor,
              deletedTransaction.destination.account.id,
              deletedTransaction.destination.amountMinor,
              deletedTransaction.memo,
            ).lastInsertRowid,
        )
      : Number(
          database
            .prepare(
              `INSERT INTO transactions (
                 kind,
                 occurred_on,
                 account_id,
                 amount_minor,
                 memo
               ) VALUES (?, ?, ?, ?, ?)`,
            )
            .run(
              deletedTransaction.kind,
              deletedTransaction.occurredOn,
              deletedTransaction.account.id,
              deletedTransaction.amountMinor,
              deletedTransaction.memo,
            ).lastInsertRowid,
        )

  if (deletedTransaction.kind === 'income' || deletedTransaction.kind === 'expense') {
    insertCategoryAssignments(
      database,
      transactionId,
      deletedTransaction.assignments.map((assignment) => ({
        categoryId: assignment.categoryId,
        amountMinor: assignment.amountMinor,
        origin: assignment.origin,
      })),
    )
  }

  for (const relation of deletedTransaction.relations) {
    if (relation.direction === 'outgoing') {
      insertTransactionRelation(database, transactionId, {
        kind: relation.relationKind,
        targetTransactionId: relation.relatedTransaction.id,
      })
    }
  }

  return transactionId
}

function mapChangeRecord(row: ChangeRecordRow): TransactionChangeRecord {
  const payload = parsePayload(row.payload, row.id)
  const transactionId = Number(row.entity_id)

  if (!Number.isSafeInteger(transactionId) || transactionId <= 0) {
    throw new Error(`Change Record ${row.id} has an invalid Transaction ID`)
  }

  return {
    id: row.id,
    transactionId,
    action: row.action,
    payload,
    recordedAt: row.recorded_at,
    description: describeChangeRecord(row.action, transactionId, payload),
  }
}

function parsePayload(payload: string, changeRecordId: number): Record<string, unknown> {
  let parsed: unknown

  try {
    parsed = JSON.parse(payload)
  } catch {
    throw new Error(`Change Record ${changeRecordId} has invalid JSON`)
  }

  if (!isRecord(parsed)) {
    throw new Error(`Change Record ${changeRecordId} payload must be an object`)
  }

  return parsed
}

function describeChangeRecord(
  action: TransactionChangeRecord['action'],
  transactionId: number,
  payload: Record<string, unknown>,
): string {
  const transaction = isTransactionState(payload.transaction) ? payload.transaction : undefined
  const previousTransaction = isTransactionState(payload.previousTransaction)
    ? payload.previousTransaction
    : undefined
  const balanceChanges = formatBalanceChanges(payload.balanceChanges)

  if (
    action === 'created' &&
    transaction &&
    typeof payload.recreatedFromChangeRecordId === 'number'
  ) {
    return (
      `Recreated deleted Transaction ${String(payload.deletedTransactionId)} as ` +
      `${formatTransactionState(transaction)} from Change Record ` +
      `${payload.recreatedFromChangeRecordId}.${balanceChanges}`
    )
  }

  if (action === 'updated' && previousTransaction && transaction) {
    return (
      `Edited Transaction ${transactionId} from ${formatTransactionState(previousTransaction)} ` +
      `to ${formatTransactionState(transaction)}.${balanceChanges}`
    )
  }

  if (action === 'deleted' && transaction) {
    return `Deleted ${formatTransactionState(transaction)}.${balanceChanges}`
  }

  const legacyTransaction = formatLegacyTransaction(payload.transaction)

  if (legacyTransaction !== null) {
    return (
      `${capitalize(action)} ${legacyTransaction}.` +
      `${formatLegacyMutationDetails(payload)}${balanceChanges}`
    )
  }

  return `${capitalize(action)} Transaction ${transactionId} with complete structured details.`
}

function formatTransactionState(transaction: TransactionState): string {
  const memo = transaction.memo === null ? 'no memo' : `memo "${transaction.memo}"`
  const relations =
    transaction.relations.length === 0
      ? 'no relations'
      : transaction.relations
          .map(
            (relation) =>
              `${relation.direction} ${relation.relationKind} Transaction ` +
              `${relation.relatedTransaction.id}`,
          )
          .join(', ')

  if (transaction.kind === 'transfer') {
    return (
      `Transfer Transaction ${transaction.id} on ${transaction.occurredOn}: ` +
      `source Account ${transaction.source.account.id} "${transaction.source.account.name}" ` +
      `sends ${transaction.source.amountMinor} ${transaction.source.account.currency}; ` +
      `destination Account ${transaction.destination.account.id} ` +
      `"${transaction.destination.account.name}" receives ` +
      `${transaction.destination.amountMinor} ${transaction.destination.account.currency}; ` +
      `${memo}; ${relations}`
    )
  }

  const base =
    `${capitalize(transaction.kind)} Transaction ${transaction.id} on ` +
    `${transaction.occurredOn}: Account ${transaction.account.id} ` +
    `"${transaction.account.name}", ${transaction.amountMinor} ` +
    `${transaction.account.currency}; ${memo}`

  if (transaction.kind === 'adjustment') {
    return `${base}; ${relations}`
  }

  const assignments =
    transaction.assignments.length === 0
      ? 'uncategorized'
      : transaction.assignments
          .map(
            (assignment) =>
              `${assignment.origin} Category "${assignment.categoryPath}" ` +
              `${assignment.amountMinor} ${transaction.account.currency}`,
          )
          .join(', ')

  return `${base}; ${assignments}; ${relations}`
}

function formatLegacyTransaction(value: unknown): string | null {
  if (!isRecord(value) || typeof value.id !== 'number' || typeof value.kind !== 'string') {
    return null
  }

  const occurredOn = typeof value.occurredOn === 'string' ? value.occurredOn : 'unknown date'
  const memo =
    value.memo === null
      ? 'no memo'
      : typeof value.memo === 'string'
        ? `memo "${value.memo}"`
        : 'memo unspecified'

  if (value.kind === 'transfer' && isRecord(value.source) && isRecord(value.destination)) {
    return (
      `Transfer Transaction ${value.id} on ${occurredOn}: ` +
      `${formatLegacyEndpoint('source', value.source)}; ` +
      `${formatLegacyEndpoint('destination', value.destination)}; ${memo}`
    )
  }

  if (
    (value.kind === 'income' || value.kind === 'expense' || value.kind === 'adjustment') &&
    isRecord(value.account)
  ) {
    const accountId = String(value.account.id)
    const accountName = typeof value.account.name === 'string' ? ` "${value.account.name}"` : ''
    const currency = typeof value.account.currency === 'string' ? ` ${value.account.currency}` : ''

    return (
      `${capitalize(value.kind)} Transaction ${value.id} on ${occurredOn}: ` +
      `Account ${accountId}${accountName}, ${String(value.amountMinor)}${currency}; ${memo}`
    )
  }

  return `${capitalize(value.kind)} Transaction ${value.id} on ${occurredOn}; ${memo}`
}

function formatLegacyEndpoint(
  role: 'source' | 'destination',
  value: Record<string, unknown>,
): string {
  const account = isRecord(value.account) ? value.account : {}
  const verb = role === 'source' ? 'sends' : 'receives'

  return (
    `${role} Account ${String(account.id)} "${String(account.name)}" ` +
    `${verb} ${String(value.amountMinor)} ${String(account.currency)}`
  )
}

function formatLegacyMutationDetails(payload: Record<string, unknown>): string {
  const details: string[] = []

  if (
    typeof payload.previousBalanceMinor === 'number' &&
    typeof payload.resultingBalanceMinor === 'number'
  ) {
    details.push(
      `Account balance ${payload.previousBalanceMinor} to ${payload.resultingBalanceMinor}`,
    )
  }

  if (
    typeof payload.sourcePreviousBalanceMinor === 'number' &&
    typeof payload.sourceResultingBalanceMinor === 'number' &&
    typeof payload.destinationPreviousBalanceMinor === 'number' &&
    typeof payload.destinationResultingBalanceMinor === 'number'
  ) {
    details.push(
      `source balance ${payload.sourcePreviousBalanceMinor} to ` +
        `${payload.sourceResultingBalanceMinor}`,
      `destination balance ${payload.destinationPreviousBalanceMinor} to ` +
        `${payload.destinationResultingBalanceMinor}`,
    )
  }

  if (typeof payload.adjustmentAmountMinor === 'number') {
    details.push(`applied Adjustment ${payload.adjustmentAmountMinor} minor units`)
  }

  if (typeof payload.requestedTargetBalanceMinor === 'number') {
    details.push(`requested target balance ${payload.requestedTargetBalanceMinor}`)
  }

  if (isRecord(payload.relation)) {
    details.push(
      `${String(payload.relation.kind)} relation to Transaction ` +
        `${String(payload.relation.targetTransactionId)}`,
    )
  } else if (payload.relation === null) {
    details.push('no outgoing relation')
  }

  if (Array.isArray(payload.previousAssignments)) {
    details.push(
      `previous Category Assignments: ${formatLegacyAssignmentList(payload.previousAssignments)}`,
    )
  }

  if (Array.isArray(payload.assignments)) {
    details.push(`applied Category Assignments: ${formatLegacyAssignmentList(payload.assignments)}`)
  }

  if (typeof payload.uncategorizedAmountMinor === 'number') {
    details.push(`uncategorized remainder ${payload.uncategorizedAmountMinor}`)
  }

  return details.length === 0 ? '' : ` ${details.join('; ')}.`
}

function formatLegacyAssignmentList(assignments: unknown[]): string {
  if (assignments.length === 0) {
    return 'none'
  }

  return assignments
    .map((assignment) => {
      if (!isRecord(assignment)) {
        return 'invalid assignment'
      }

      const category = isRecord(assignment.category) ? assignment.category : {}
      return (
        `${String(assignment.origin)} Category "${String(category.path)}" ` +
        `${String(assignment.amountMinor)} ${String(assignment.currency)}`
      )
    })
    .join(', ')
}

function formatBalanceChanges(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) {
    return ''
  }

  const changes = value
    .filter(isRecord)
    .map(
      (change) =>
        `Account ${String(change.accountId)} ${String(change.currency)} balance ` +
        `${String(change.previousBalanceMinor)} to ${String(change.resultingBalanceMinor)}`,
    )

  return changes.length === 0 ? '' : ` Balances: ${changes.join('; ')}.`
}

function isTransactionState(value: unknown): value is TransactionState {
  if (
    !isRecord(value) ||
    typeof value.id !== 'number' ||
    typeof value.kind !== 'string' ||
    typeof value.occurredOn !== 'string' ||
    (value.memo !== null && typeof value.memo !== 'string') ||
    !Array.isArray(value.relations)
  ) {
    return false
  }

  if (value.kind === 'transfer') {
    return isStoredEndpoint(value.source) && isStoredEndpoint(value.destination)
  }

  if (value.kind !== 'income' && value.kind !== 'expense' && value.kind !== 'adjustment') {
    return false
  }

  if (!isTransactionAccount(value.account) || typeof value.amountMinor !== 'number') {
    return false
  }

  return value.kind === 'adjustment' || Array.isArray(value.assignments)
}

function isStoredEndpoint(value: unknown): boolean {
  return (
    isRecord(value) && isTransactionAccount(value.account) && typeof value.amountMinor === 'number'
  )
}

function isTransactionAccount(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === 'number' &&
    typeof value.name === 'string' &&
    (value.nature === 'asset' || value.nature === 'liability') &&
    typeof value.currency === 'string' &&
    typeof value.archived === 'boolean'
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireNumber(value: number | null, label: string): number {
  if (value === null) {
    throw new Error(`${label} is missing`)
  }

  return value
}

function capitalize(value: string): string {
  return value.length === 0 ? value : value.charAt(0).toUpperCase() + value.slice(1)
}
