import type {
  Account,
  BalanceChange,
  Category,
  CategoryAssignment,
  EntityId,
  FinStorage,
  Transaction,
  TransactionRelation,
} from '@fin/provider'
import { change } from './change.js'
import { accountIds, duplicate, transactionPlan, validateTransaction } from './transaction-plan.js'
import { calendarDate, invalid, money, required, revision } from './validation.js'

export interface IncomeExpenseInput {
  kind: 'income' | 'expense'
  accountId?: EntityId
  amountMinor: number
  occurredOn?: string
  memo?: string | null
  assignments?: CategoryAssignment[]
  allowDuplicate?: boolean
}
export interface RefundInput {
  accountId?: EntityId
  amountMinor: number
  occurredOn?: string
  memo?: string | null
  originalExpenseId?: EntityId
  allowDuplicate?: boolean
}
export interface TransactionPatch {
  occurredOn?: string
  memo?: string | null
  accountId?: EntityId
  amountMinor?: number
  sourceAccountId?: EntityId
  sourceAmountMinor?: number
  destinationAccountId?: EntityId
  destinationAmountMinor?: number
  assignments?: CategoryAssignment[]
  relations?: TransactionRelation[]
}
export interface TransactionResult {
  changed: boolean
  transaction: Transaction
  balances: BalanceChange[]
  accounts: Account[]
  categories: Category[]
  dateDefaulted?: boolean
  accountDefaulted?: boolean
  relatedTransactions?: Transaction[]
}
export interface TransferInput {
  sourceAccountId: EntityId
  sourceAmountMinor: number
  destinationAccountId: EntityId
  destinationAmountMinor: number
  occurredOn?: string
  memo?: string | null
  allowDuplicate?: boolean
}
export interface AdjustmentResult {
  changed: boolean
  transaction: Transaction | null
  balances: BalanceChange[]
  accounts: Account[]
  categories: Category[]
  targetBalanceMinor: number
}

export class Transactions {
  readonly #storage: FinStorage
  readonly #vaultId: string
  readonly #dates: Intl.DateTimeFormat

  constructor(storage: FinStorage, vaultId: string, timeZone?: string) {
    this.#storage = storage
    this.#vaultId = vaultId
    this.#dates = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
  }

  #date(value?: string): string {
    if (value !== undefined) return calendarDate(value)
    const parts = this.#dates.formatToParts(new Date()),
      get = (type: string) => required(parts.find((p) => p.type === type)?.value)
    return `${get('year')}-${get('month')}-${get('day')}`
  }

  async #record(input: IncomeExpenseInput, relation?: Transaction['relations'][number]) {
    const id = crypto.randomUUID(),
      occurredOn = this.#date(input.occurredOn),
      memo = input.memo?.trim() || null
    money(input.amountMinor)
    invalid(
      input.kind === 'income' || input.kind === 'expense',
      'Transaction kind must be income or expense.',
    )
    return change(
      this.#storage,
      {
        kind: 'transaction',
        vaultId: this.#vaultId,
        accountIds: input.accountId ? [input.accountId] : [],
        categoryIds: input.assignments?.map((a) => a.categoryId),
        relatedIds: relation ? [relation.targetTransactionId] : [],
        duplicate: input.allowDuplicate
          ? undefined
          : {
              kind: input.kind,
              accountId: input.accountId,
              amountMinor: input.amountMinor,
              occurredOn,
              memo,
            },
      },
      'transaction',
      id,
      'created',
      (c, token) => {
        const settings = required(c.settings)
        const accountId = required(
          input.accountId ??
            (input.kind === 'income' ? settings.incomeAccountId : settings.expenseAccountId),
        )
        const transaction: Transaction = {
          id,
          revision: token,
          kind: input.kind,
          accountId,
          amountMinor: input.amountMinor,
          occurredOn,
          memo,
          assignments: [...(input.assignments ?? [])].sort((a, b) =>
            a.categoryId.localeCompare(b.categoryId),
          ),
          relations: relation ? [relation] : [],
        }
        const plan = transactionPlan(c, null, transaction, token)
        duplicate(c, transaction, input.allowDuplicate)
        return {
          ...plan,
          result: {
            ...plan.result,
            dateDefaulted: input.occurredOn === undefined,
            accountDefaulted: input.accountId === undefined,
          },
        }
      },
    )
  }

  async editTransaction(input: { id: string; expectedRevision: string; patch: TransactionPatch }) {
    const { patch } = input
    return change<TransactionResult>(
      this.#storage,
      {
        kind: 'transaction',
        vaultId: this.#vaultId,
        id: input.id,
        accountIds: [patch.accountId, patch.sourceAccountId, patch.destinationAccountId].filter(
          (id): id is string => typeof id === 'string',
        ),
        categoryIds: patch.assignments?.map((a) => a.categoryId),
        relatedIds: patch.relations?.map((r) => r.targetTransactionId),
      },
      'transaction',
      input.id,
      'updated',
      (c, token) => {
        const before = required(
          c.transactions.find((t) => t.id === input.id),
          input.id,
        )
        revision(before.revision, input.expectedRevision)
        const base = {
          id: before.id,
          revision: before.revision,
          kind: before.kind,
          occurredOn: patch.occurredOn ?? before.occurredOn,
          memo: patch.memo === undefined ? before.memo : patch.memo?.trim() || null,
          assignments: [...(patch.assignments ?? before.assignments)].sort((a, b) =>
            a.categoryId.localeCompare(b.categoryId),
          ),
          relations: [...(patch.relations ?? before.relations)].sort(
            (a, b) =>
              a.targetTransactionId.localeCompare(b.targetTransactionId) ||
              a.kind.localeCompare(b.kind),
          ),
        }
        let after: Transaction
        if (before.kind === 'transfer') {
          invalid(
            patch.accountId === undefined && patch.amountMinor === undefined,
            'Transfers require explicit source and destination fields.',
          )
          after = {
            ...base,
            kind: 'transfer',
            sourceAccountId: patch.sourceAccountId ?? before.sourceAccountId,
            sourceAmountMinor: patch.sourceAmountMinor ?? before.sourceAmountMinor,
            destinationAccountId: patch.destinationAccountId ?? before.destinationAccountId,
            destinationAmountMinor: patch.destinationAmountMinor ?? before.destinationAmountMinor,
          }
        } else {
          invalid(
            patch.sourceAccountId === undefined &&
              patch.destinationAccountId === undefined &&
              patch.sourceAmountMinor === undefined &&
              patch.destinationAmountMinor === undefined,
            'Single-account transactions cannot have transfer fields.',
          )
          after = {
            ...base,
            kind: before.kind,
            accountId: patch.accountId ?? before.accountId,
            amountMinor: patch.amountMinor ?? before.amountMinor,
          }
        }
        validateTransaction(after, c, before)
        if (JSON.stringify({ ...before, ...after }) === JSON.stringify(before))
          return {
            unchanged: {
              changed: false,
              transaction: before,
              balances: [],
              accounts: c.accounts.filter((a) => accountIds(before).includes(a.id)),
              categories: c.categories.filter((a) =>
                before.assignments.some((b) => b.categoryId === a.id),
              ),
            },
          }
        after.revision = token
        return transactionPlan(c, before, after, token)
      },
    )
  }

  async recordTransfer(input: TransferInput) {
    const id = crypto.randomUUID(),
      occurredOn = this.#date(input.occurredOn)
    return change(
      this.#storage,
      {
        kind: 'transaction',
        vaultId: this.#vaultId,
        accountIds: [input.sourceAccountId, input.destinationAccountId],
        duplicate: input.allowDuplicate
          ? undefined
          : {
              kind: 'transfer',
              sourceAccountId: input.sourceAccountId,
              sourceAmountMinor: input.sourceAmountMinor,
              destinationAccountId: input.destinationAccountId,
              destinationAmountMinor: input.destinationAmountMinor,
              occurredOn,
              memo: input.memo?.trim() || null,
            },
      },
      'transaction',
      id,
      'created',
      (c, token) => {
        const transaction: Transaction = {
          id,
          revision: token,
          kind: 'transfer',
          occurredOn,
          memo: input.memo?.trim() || null,
          sourceAccountId: input.sourceAccountId,
          sourceAmountMinor: input.sourceAmountMinor,
          destinationAccountId: input.destinationAccountId,
          destinationAmountMinor: input.destinationAmountMinor,
          assignments: [],
          relations: [],
        }
        validateTransaction(transaction, c, null)
        duplicate(c, transaction, input.allowDuplicate)
        return transactionPlan(c, null, transaction, token)
      },
    )
  }

  async recordTransferFee(input: Omit<RefundInput, 'originalExpenseId'> & { transferId: string }) {
    invalid(money(input.amountMinor) > 0, 'Transfer fees must be positive.')
    return this.#record(
      { ...input, kind: 'expense' },
      { kind: 'fee_for', targetTransactionId: input.transferId },
    )
  }

  async adjustAccountBalance(input: {
    accountId: string
    expectedRevision: string
    targetBalanceMinor: number
    occurredOn?: string
    memo?: string | null
  }) {
    money(input.targetBalanceMinor)
    const id = crypto.randomUUID(),
      occurredOn = this.#date(input.occurredOn)
    return change<AdjustmentResult>(
      this.#storage,
      { kind: 'transaction', vaultId: this.#vaultId, accountIds: [input.accountId] },
      'transaction',
      id,
      'created',
      (c, token) => {
        const account = required(
          c.accounts.find((a) => a.id === input.accountId),
          input.accountId,
        )
        revision(account.balanceRevision, input.expectedRevision)
        if (account.balanceMinor === input.targetBalanceMinor)
          return {
            unchanged: {
              changed: false,
              transaction: null,
              balances: [],
              accounts: [account],
              categories: [],
              targetBalanceMinor: input.targetBalanceMinor,
            },
          }
        const transaction: Transaction = {
          id,
          revision: token,
          kind: 'adjustment',
          occurredOn,
          memo: input.memo?.trim() || null,
          accountId: account.id,
          amountMinor: money(input.targetBalanceMinor - account.balanceMinor),
          assignments: [],
          relations: [],
        }
        const plan = transactionPlan(c, null, transaction, token)
        return {
          ...plan,
          result: { ...plan.result, targetBalanceMinor: input.targetBalanceMinor },
        }
      },
    )
  }

  async recordAdjustment(input: {
    accountId: string
    amountMinor: number
    occurredOn?: string
    memo?: string | null
  }) {
    const id = crypto.randomUUID(),
      occurredOn = this.#date(input.occurredOn)
    return change(
      this.#storage,
      { kind: 'transaction', vaultId: this.#vaultId, accountIds: [input.accountId] },
      'transaction',
      id,
      'created',
      (c, token) =>
        transactionPlan(
          c,
          null,
          {
            id,
            revision: token,
            kind: 'adjustment',
            occurredOn,
            memo: input.memo?.trim() || null,
            accountId: input.accountId,
            amountMinor: money(input.amountMinor),
            assignments: [],
            relations: [],
          },
          token,
        ),
    )
  }

  async setCategoryAssignments(input: {
    id: string
    expectedRevision: string
    assignments: CategoryAssignment[]
  }) {
    return this.editTransaction({
      id: input.id,
      expectedRevision: input.expectedRevision,
      patch: { assignments: input.assignments },
    })
  }

  async deleteTransaction(input: { id: string; expectedRevision: string }) {
    return change(
      this.#storage,
      { kind: 'transaction', vaultId: this.#vaultId, id: input.id },
      'transaction',
      input.id,
      'deleted',
      (c, token) => {
        const before = required(
          c.transactions.find((t) => t.id === input.id),
          input.id,
        )
        revision(before.revision, input.expectedRevision)
        return transactionPlan(c, before, null, token)
      },
    )
  }

  async recreateTransaction({ changeRecordId }: { changeRecordId: string }) {
    const id = crypto.randomUUID()
    return change(
      this.#storage,
      { kind: 'transaction', vaultId: this.#vaultId, recordId: changeRecordId },
      'transaction',
      id,
      'recreated',
      (c, token) => {
        const record = required(c.records[0], changeRecordId)
        invalid(
          record.target === 'transaction' &&
            record.action === 'deleted' &&
            record.before !== null &&
            'transaction' in record.before,
          'Recreation requires a transaction deletion record.',
        )
        const transaction: Transaction = { ...record.before.transaction, id, revision: token }
        const deleted = record.before.transaction
        const plan = transactionPlan(c, null, transaction, token)
        return {
          ...plan,
          result: {
            ...plan.result,
            recreatedFromChangeRecordId: changeRecordId,
            deletedTransactionId: deleted.id,
            omittedIncomingRelations: record.before.relatedTransactions.filter((t) =>
              t.relations.some((r) => r.targetTransactionId === deleted.id),
            ),
          },
        }
      },
    )
  }

  recordIncomeExpense(input: IncomeExpenseInput) {
    return this.#record(input)
  }

  async recordRefund(input: RefundInput) {
    invalid(
      money(input.amountMinor) > 0,
      'Refund amounts must be positive; they are recorded as negative expenses.',
    )
    return this.#record(
      { ...input, kind: 'expense', amountMinor: -input.amountMinor },
      input.originalExpenseId
        ? { kind: 'refund_of', targetTransactionId: input.originalExpenseId }
        : undefined,
    )
  }
}
