import { type Account, listAccounts } from './accounts.js'
import {
  type Category,
  type CategoryCreation,
  createCategory,
  listCategories,
} from './categories.js'
import { type CategoryAssignment, setCategoryAssignments } from './classifications.js'
import { recordRefund } from './related-expenses.js'
import {
  type IncomeExpenseKind,
  type IncomeExpenseTransaction,
  normalizeMemo,
  recordIncomeExpense,
  type TransactionAccount,
  validateCalendarDate,
} from './transactions.js'
import { openVault, withVaultDatabase } from './vault.js'

export type AgentTransactionIntent = {
  kind?: IncomeExpenseKind | undefined
  accountId?: number | undefined
  accountName?: string | undefined
  amountMinor: number
  occurredOn?: string | undefined
  memo?: string | null | undefined
  categoryId?: number | undefined
  categoryQuery?: string | undefined
  categoryAmountMinor?: number | undefined
  proposedCategory?: CategoryCreation | undefined
  confirmNewCategory?: boolean | undefined
  confirmDuplicate?: boolean | undefined
}

export type AgentResolutionStatus = 'needs_clarification' | 'confirmation_required' | 'recorded'

export type AgentResolutionReason =
  | 'transaction_kind_ambiguity'
  | 'account_ambiguity'
  | 'category_ambiguity'
  | 'new_category_confirmation'
  | 'duplicate_confirmation'

export type AgentTransactionKindCandidate = {
  kind: IncomeExpenseKind
  label: 'Income' | 'Expense'
}

export type AgentCandidateSet = {
  transactionKinds: AgentTransactionKindCandidate[]
  accounts: Account[]
  categories: Category[]
}

export type AgentDuplicateMatch = {
  transactionId: number
  kind: IncomeExpenseKind
  occurredOn: string
  account: TransactionAccount
  amountMinor: number
  memo: string | null
}

export type AgentAppliedSource =
  | 'explicit'
  | 'inferred'
  | 'default'
  | 'default_no_memo'
  | 'omitted'
  | 'confirmed_new'
  | 'default_full_amount'

export type AgentAppliedValue<Value> = {
  value: Value
  source: AgentAppliedSource
}

export type AgentMutationReceipt = {
  transaction: IncomeExpenseTransaction
  previousBalanceMinor: number
  resultingBalanceMinor: number
  categoryAssignment: CategoryAssignment | null
  uncategorizedAmountMinor: number
  createdCategory: Category | null
  duplicateConfirmation: 'not_needed' | 'confirmed'
  applied: {
    kind: AgentAppliedValue<IncomeExpenseKind>
    account: AgentAppliedValue<TransactionAccount>
    amountMinor: AgentAppliedValue<number>
    occurredOn: AgentAppliedValue<string>
    memo: AgentAppliedValue<string | null>
    category: AgentAppliedValue<{ id: number; path: string } | null>
    categoryAmountMinor: AgentAppliedValue<number | null>
  }
}

export type AgentTransactionResult = {
  status: AgentResolutionStatus
  reason: AgentResolutionReason | null
  message: string
  candidates: AgentCandidateSet
  duplicateMatches: AgentDuplicateMatch[]
  proposedCategory: CategoryCreation | null
  receipt: AgentMutationReceipt | null
}

type AccountResolution =
  | {
      status: 'resolved'
      account: Account
      source: 'explicit' | 'inferred' | 'default'
    }
  | {
      status: 'ambiguous'
      candidates: Account[]
      message: string
    }

type CategoryResolution =
  | {
      status: 'omitted'
    }
  | {
      status: 'resolved'
      category: Category
      source: 'explicit' | 'inferred'
    }
  | {
      status: 'ambiguous'
      candidates: Category[]
      message: string
    }
  | {
      status: 'proposed'
      proposal: CategoryCreation
    }

type DuplicateRow = {
  id: number
  kind: IncomeExpenseKind
  occurred_on: string
  account_id: number
  account_name: string
  account_nature: TransactionAccount['nature']
  account_currency: string
  account_archived_at: string | null
  amount_minor: number
  memo: string | null
}

const noCandidates: AgentCandidateSet = {
  transactionKinds: [],
  accounts: [],
  categories: [],
}

export function recordAgentTransaction(
  vaultPath: string,
  intent: AgentTransactionIntent,
): AgentTransactionResult {
  const amountMinor = validateAmount(intent.amountMinor, intent.kind)
  const occurredOn =
    intent.occurredOn === undefined
      ? formatCurrentLocalDate()
      : validateCalendarDate(intent.occurredOn)
  const occurredOnSource = intent.occurredOn === undefined ? 'default' : 'explicit'
  const memo = normalizeMemo(intent.memo)
  const memoSource = intent.memo === undefined ? 'default_no_memo' : 'explicit'

  if (intent.kind === undefined) {
    return unresolvedResult(
      'transaction_kind_ambiguity',
      'Income and Expense are both plausible; choose the Transaction kind before recording.',
      {
        ...noCandidates,
        transactionKinds: [
          { kind: 'income', label: 'Income' },
          { kind: 'expense', label: 'Expense' },
        ],
      },
    )
  }

  const kind = intent.kind
  const accounts = listAccounts(vaultPath)
  const accountResolution = resolveAccount(vaultPath, intent, kind, accounts)

  if (accountResolution.status === 'ambiguous') {
    return unresolvedResult('account_ambiguity', accountResolution.message, {
      ...noCandidates,
      accounts: accountResolution.candidates,
    })
  }

  const categories = listCategories(vaultPath)
  const categoryResolution = resolveCategory(intent, categories)

  if (categoryResolution.status === 'ambiguous') {
    return unresolvedResult('category_ambiguity', categoryResolution.message, {
      ...noCandidates,
      categories: categoryResolution.candidates,
    })
  }

  const categoryAmountMinor = validateCategoryAmount(
    intent.categoryAmountMinor,
    amountMinor,
    categoryResolution.status !== 'omitted',
  )
  const duplicateMatches = readDuplicateMatches(
    vaultPath,
    kind,
    accountResolution.account.id,
    amountMinor,
    occurredOn,
    memo,
  )

  if (duplicateMatches.length > 0 && intent.confirmDuplicate !== true) {
    return {
      status: 'confirmation_required',
      reason: 'duplicate_confirmation',
      message:
        'A likely duplicate matches the applied date, Account, kind, amount, and memo; ' +
        'confirm that this is a legitimate duplicate before recording it.',
      candidates: noCandidates,
      duplicateMatches,
      proposedCategory:
        categoryResolution.status === 'proposed' ? categoryResolution.proposal : null,
      receipt: null,
    }
  }

  if (categoryResolution.status === 'proposed' && intent.confirmNewCategory !== true) {
    return {
      status: 'confirmation_required',
      reason: 'new_category_confirmation',
      message:
        `No unambiguous existing Category matches. Confirm creation of ` +
        `"${categoryResolution.proposal.name}" before recording.`,
      candidates: noCandidates,
      duplicateMatches,
      proposedCategory: categoryResolution.proposal,
      receipt: null,
    }
  }

  let createdCategory: Category | null = null
  let appliedCategory: Category | null = null
  let categorySource: AgentMutationReceipt['applied']['category']['source'] = 'omitted'

  if (categoryResolution.status === 'resolved') {
    appliedCategory = categoryResolution.category
    categorySource = categoryResolution.source
  } else if (categoryResolution.status === 'proposed') {
    createdCategory = createCategory(vaultPath, categoryResolution.proposal).category
    appliedCategory = createdCategory
    categorySource = 'confirmed_new'
  }

  const recordResult =
    kind === 'expense' && amountMinor < 0
      ? recordRefund(vaultPath, {
          accountId: accountResolution.account.id,
          amountMinor: -amountMinor,
          occurredOn,
          memo,
        })
      : recordIncomeExpense(vaultPath, {
          kind,
          accountId: accountResolution.account.id,
          amountMinor,
          occurredOn,
          memo,
        })
  let categoryAssignment: CategoryAssignment | null = null
  let uncategorizedAmountMinor = amountMinor

  if (appliedCategory !== null && categoryAmountMinor !== null) {
    const classification = setCategoryAssignments(vaultPath, recordResult.transaction.id, [
      {
        categoryId: appliedCategory.id,
        amountMinor: categoryAmountMinor,
        origin: categorySource === 'inferred' ? 'inferred' : 'explicit',
      },
    ])
    categoryAssignment = classification.assignments[0] ?? null
    uncategorizedAmountMinor = classification.uncategorizedAmountMinor
  }

  const receipt: AgentMutationReceipt = {
    transaction: recordResult.transaction,
    previousBalanceMinor: recordResult.previousBalanceMinor,
    resultingBalanceMinor: recordResult.resultingBalanceMinor,
    categoryAssignment,
    uncategorizedAmountMinor,
    createdCategory,
    duplicateConfirmation: duplicateMatches.length === 0 ? 'not_needed' : 'confirmed',
    applied: {
      kind: {
        value: kind,
        source: 'explicit',
      },
      account: {
        value: recordResult.transaction.account,
        source: accountResolution.source,
      },
      amountMinor: {
        value: amountMinor,
        source: 'explicit',
      },
      occurredOn: {
        value: occurredOn,
        source: occurredOnSource,
      },
      memo: {
        value: memo,
        source: memoSource,
      },
      category: {
        value:
          appliedCategory === null ? null : { id: appliedCategory.id, path: appliedCategory.path },
        source: categorySource,
      },
      categoryAmountMinor: {
        value: categoryAmountMinor,
        source:
          categoryAmountMinor === null
            ? 'omitted'
            : intent.categoryAmountMinor === undefined
              ? 'default_full_amount'
              : 'explicit',
      },
    },
  }

  return {
    status: 'recorded',
    reason: null,
    message: 'Recorded the Transaction with all applied, defaulted, and inferred values disclosed.',
    candidates: noCandidates,
    duplicateMatches,
    proposedCategory: categoryResolution.status === 'proposed' ? categoryResolution.proposal : null,
    receipt,
  }
}

function resolveAccount(
  vaultPath: string,
  intent: AgentTransactionIntent,
  kind: IncomeExpenseKind,
  accounts: Account[],
): AccountResolution {
  if (intent.accountId !== undefined && intent.accountName !== undefined) {
    throw new Error('Specify either Account ID or Account name, not both')
  }

  const activeAccounts = accounts.filter((account) => !account.archived)

  if (intent.accountId !== undefined) {
    const accountId = validatePositiveId(intent.accountId, 'Account')
    const account = accounts.find((candidate) => candidate.id === accountId)

    if (!account) {
      throw new Error(`Account ${accountId} does not exist`)
    }

    if (account.archived) {
      throw new Error(`Archived Account ${account.id} ("${account.name}") cannot be used`)
    }

    return { status: 'resolved', account, source: 'explicit' }
  }

  if (intent.accountName !== undefined) {
    const query = normalizeQuery(intent.accountName, 'Account')
    const exact = activeAccounts.filter(
      (account) => account.name.toLocaleLowerCase() === query.toLocaleLowerCase(),
    )
    const matches =
      exact.length > 0
        ? exact
        : activeAccounts.filter((account) =>
            account.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
          )

    if (matches.length === 1) {
      return {
        status: 'resolved',
        account: matches[0] as Account,
        source: exact.length === 1 ? 'explicit' : 'inferred',
      }
    }

    return {
      status: 'ambiguous',
      candidates: matches,
      message:
        matches.length === 0
          ? `No active Account matches "${query}"; choose an Account before recording.`
          : `More than one active Account matches "${query}"; choose one candidate before recording.`,
    }
  }

  const settings = openVault(vaultPath).settings
  const defaultAccountId =
    kind === 'income' ? settings.defaultIncomeAccountId : settings.defaultExpenseAccountId

  if (defaultAccountId !== null) {
    const account = activeAccounts.find((candidate) => candidate.id === defaultAccountId)

    if (!account) {
      throw new Error(`Default ${kind} Account ${defaultAccountId} is unavailable`)
    }

    return { status: 'resolved', account, source: 'default' }
  }

  return {
    status: 'ambiguous',
    candidates: activeAccounts,
    message: `No default ${kind} Account is configured; choose an active Account before recording.`,
  }
}

function resolveCategory(
  intent: AgentTransactionIntent,
  categories: Category[],
): CategoryResolution {
  if (
    intent.categoryId !== undefined &&
    (intent.categoryQuery !== undefined || intent.proposedCategory !== undefined)
  ) {
    throw new Error('Specify an explicit Category ID or a Category query/proposal, not both')
  }

  const activeCategories = categories.filter((category) => !category.archived)

  if (intent.categoryId !== undefined) {
    const categoryId = validatePositiveId(intent.categoryId, 'Category')
    const category = categories.find((candidate) => candidate.id === categoryId)

    if (!category) {
      throw new Error(`Category ${categoryId} does not exist`)
    }

    if (category.archived) {
      throw new Error(`Archived Category "${category.path}" cannot receive assignments`)
    }

    return { status: 'resolved', category, source: 'explicit' }
  }

  const rawQuery = intent.categoryQuery ?? intent.proposedCategory?.name

  if (rawQuery === undefined) {
    return { status: 'omitted' }
  }

  const query = normalizeQuery(rawQuery, 'Category')
  const proposalParentId =
    intent.proposedCategory?.parentId === undefined ? undefined : intent.proposedCategory.parentId
  const eligibleCategories =
    proposalParentId === undefined
      ? activeCategories
      : activeCategories.filter((category) => category.parentId === proposalParentId)
  const lowerQuery = query.toLocaleLowerCase()
  const exact = eligibleCategories.filter(
    (category) =>
      category.path.toLocaleLowerCase() === lowerQuery ||
      category.name.toLocaleLowerCase() === lowerQuery,
  )
  const matches =
    exact.length > 0
      ? exact
      : eligibleCategories.filter(
          (category) =>
            category.path.toLocaleLowerCase().includes(lowerQuery) ||
            category.name.toLocaleLowerCase().includes(lowerQuery),
        )

  if (matches.length === 1) {
    return {
      status: 'resolved',
      category: matches[0] as Category,
      source: 'inferred',
    }
  }

  if (matches.length > 1) {
    return {
      status: 'ambiguous',
      candidates: matches,
      message:
        `More than one active Category matches "${query}"; choose one complete path ` +
        'before recording.',
    }
  }

  if (intent.proposedCategory !== undefined) {
    return {
      status: 'proposed',
      proposal: normalizeCategoryProposal(intent.proposedCategory),
    }
  }

  return {
    status: 'ambiguous',
    candidates: [],
    message:
      `No existing Category matches "${query}"; propose a new Category or record ` +
      'the Transaction as uncategorized.',
  }
}

function normalizeCategoryProposal(proposal: CategoryCreation): CategoryCreation {
  const name = proposal.name.trim()

  if (name.length === 0) {
    throw new Error('Proposed Category name must not be empty')
  }

  return {
    name,
    parentId:
      proposal.parentId === undefined || proposal.parentId === null
        ? null
        : validatePositiveId(proposal.parentId, 'Parent Category'),
  }
}

function readDuplicateMatches(
  vaultPath: string,
  kind: IncomeExpenseKind,
  accountId: number,
  amountMinor: number,
  occurredOn: string,
  memo: string | null,
): AgentDuplicateMatch[] {
  return withVaultDatabase(vaultPath, (database) => {
    const rows = database
      .prepare(
        `SELECT
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
         WHERE
           transactions.kind = ?
           AND transactions.account_id = ?
           AND transactions.amount_minor = ?
           AND transactions.occurred_on = ?
           AND transactions.memo IS ?
         ORDER BY transactions.id`,
      )
      .all(kind, accountId, amountMinor, occurredOn, memo) as DuplicateRow[]

    return rows.map(mapDuplicateRow)
  })
}

function mapDuplicateRow(row: DuplicateRow): AgentDuplicateMatch {
  return {
    transactionId: row.id,
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

function validateAmount(amountMinor: number, kind: IncomeExpenseKind | undefined): number {
  if (!Number.isSafeInteger(amountMinor) || amountMinor === 0) {
    throw new Error('Transaction amount must be nonzero integer minor units')
  }

  if (kind === 'income' && amountMinor < 0) {
    throw new Error('Income amount must be positive integer minor units')
  }

  return amountMinor
}

function validateCategoryAmount(
  requestedAmount: number | undefined,
  transactionAmount: number,
  hasCategory: boolean,
): number | null {
  if (!hasCategory) {
    if (requestedAmount !== undefined) {
      throw new Error('Category amount requires a Category')
    }

    return null
  }

  const amount = requestedAmount ?? transactionAmount

  if (!Number.isSafeInteger(amount) || amount === 0) {
    throw new Error('Category amount must be nonzero integer minor units')
  }

  if (amount * transactionAmount <= 0 || Math.abs(amount) > Math.abs(transactionAmount)) {
    throw new Error('Category amount must match the Transaction sign and cannot exceed its amount')
  }

  return amount
}

function validatePositiveId(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} ID must be a positive integer`)
  }

  return value
}

function normalizeQuery(value: string, label: string): string {
  const query = value.trim()

  if (query.length === 0) {
    throw new Error(`${label} query must not be empty`)
  }

  return query
}

function unresolvedResult(
  reason: Extract<
    AgentResolutionReason,
    'transaction_kind_ambiguity' | 'account_ambiguity' | 'category_ambiguity'
  >,
  message: string,
  candidates: AgentCandidateSet,
): AgentTransactionResult {
  return {
    status: 'needs_clarification',
    reason,
    message,
    candidates,
    duplicateMatches: [],
    proposedCategory: null,
    receipt: null,
  }
}

function formatCurrentLocalDate(): string {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
