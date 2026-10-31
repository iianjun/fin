import { FinError } from '@fin/provider'
import type {
  Account,
  BalanceChange,
  DomainContext,
  Transaction,
  TransactionSnapshot,
} from '@fin/provider'
import { calendarDate, invalid, money, required } from './validation.js'

export function duplicate(c: Readonly<DomainContext>, transaction: Transaction, allowed?: boolean) {
  if (allowed) return
  const candidate = c.transactions.find(
    (t) =>
      t.kind === transaction.kind &&
      t.occurredOn === transaction.occurredOn &&
      t.memo === transaction.memo &&
      (t.kind === 'transfer' && transaction.kind === 'transfer'
        ? t.sourceAccountId === transaction.sourceAccountId &&
          t.sourceAmountMinor === transaction.sourceAmountMinor &&
          t.destinationAccountId === transaction.destinationAccountId &&
          t.destinationAmountMinor === transaction.destinationAmountMinor
        : t.kind !== 'transfer' &&
          transaction.kind !== 'transfer' &&
          t.accountId === transaction.accountId &&
          t.amountMinor === transaction.amountMinor),
  )
  if (candidate)
    throw new FinError(
      'DUPLICATE_CANDIDATE',
      `A matching ${candidate.kind} exists: ${candidate.id}, ${candidate.occurredOn}, ${candidate.memo ?? '(no memo)'}.`,
      'Inspect the matching transaction and obtain confirmation before submitting with allowDuplicate=true.',
      'not_applied',
      { id: candidate.id },
    )
}
export function accountIds(t: Transaction): string[] {
  return t.kind === 'transfer' ? [t.sourceAccountId, t.destinationAccountId] : [t.accountId]
}
function effects(t: Transaction | null, accounts: Account[]): Map<string, number> {
  const result = new Map<string, number>()
  if (!t) return result
  for (const id of accountIds(t)) {
    const account = required(
        accounts.find((a) => a.id === id),
        id,
      ),
      sign = account.nature === 'asset' ? 1 : -1
    result.set(
      id,
      money(
        t.kind === 'transfer'
          ? (id === t.sourceAccountId ? -t.sourceAmountMinor : t.destinationAmountMinor) * sign
          : t.kind === 'adjustment'
            ? t.amountMinor
            : t.amountMinor * (t.kind === 'income' ? 1 : -1) * sign,
      ),
    )
  }
  return result
}
export function validateTransaction(
  t: Transaction,
  c: Readonly<DomainContext>,
  before: Transaction | null,
) {
  calendarDate(t.occurredOn)
  invalid(
    t.memo === null || (typeof t.memo === 'string' && t.memo.length <= 2000),
    'Memo must contain at most 2000 characters.',
  )
  for (const id of accountIds(t)) {
    const account = required(
      c.accounts.find((a) => a.id === id),
      id,
    )
    invalid(
      !account.archived || (before !== null && accountIds(before).includes(id)),
      'Archived accounts cannot receive new transactions.',
    )
  }
  if (t.kind === 'transfer') {
    invalid(t.sourceAccountId !== t.destinationAccountId, 'Transfer accounts must differ.')
    invalid(
      money(t.sourceAmountMinor) > 0 && money(t.destinationAmountMinor) > 0,
      'Transfer amounts must be positive.',
    )
    const source = required(c.accounts.find((a) => a.id === t.sourceAccountId)),
      destination = required(c.accounts.find((a) => a.id === t.destinationAccountId))
    invalid(
      source.currency !== destination.currency || t.sourceAmountMinor === t.destinationAmountMinor,
      'Same-currency transfers require equal amounts.',
    )
  } else {
    money(t.amountMinor)
    invalid(
      t.kind === 'income' ? t.amountMinor > 0 : t.amountMinor !== 0,
      'Income must be positive; expenses and adjustments must be nonzero.',
    )
  }
  invalid(
    Array.isArray(t.assignments) && t.assignments.length <= 32,
    'At most 32 category assignments are supported per transaction.',
  )
  invalid(
    t.kind === 'income' || t.kind === 'expense' || t.assignments.length === 0,
    'Transfers and adjustments cannot have categories.',
  )
  invalid(
    new Set(t.assignments.map((a) => a.categoryId)).size === t.assignments.length,
    'A category may be assigned only once.',
  )
  let total = 0
  for (const assignment of t.assignments) {
    const category = required(
      c.categories.find((a) => a.id === assignment.categoryId),
      assignment.categoryId,
    )
    const retained = before?.assignments.some(
      (a) =>
        a.categoryId === assignment.categoryId &&
        a.amountMinor === assignment.amountMinor &&
        a.origin === assignment.origin,
    )
    invalid(!category.archived || retained, 'Archived categories cannot receive new assignments.')
    invalid(
      assignment.origin === 'explicit' || assignment.origin === 'inferred',
      'Assignment origin must be explicit or inferred.',
    )
    invalid(
      t.kind !== 'transfer' &&
        money(assignment.amountMinor) !== 0 &&
        Math.sign(assignment.amountMinor) === Math.sign(t.amountMinor),
      'Assignment amounts must have the transaction sign.',
    )
    total = money(total + assignment.amountMinor)
  }
  if (t.kind !== 'transfer')
    invalid(
      Math.abs(total) <= Math.abs(t.amountMinor),
      'Assigned amounts cannot exceed the transaction amount.',
    )
  invalid(t.relations.length <= 32, 'At most 32 relations are supported per transaction.')
  for (const relation of t.relations) {
    const target = required(
      c.transactions.find((a) => a.id === relation.targetTransactionId),
      relation.targetTransactionId,
    )
    invalid(
      t.id !== target.id && t.kind === 'expense',
      'Only expenses may reference another transaction.',
    )
    invalid(
      relation.kind === 'refund_of'
        ? t.amountMinor < 0 && target.kind === 'expense' && target.amountMinor > 0
        : relation.kind === 'fee_for' && t.amountMinor > 0 && target.kind === 'transfer',
      'A refund must reference a positive expense; a fee must reference a transfer.',
    )
  }
  if (before) {
    for (const source of c.transactions.filter((a) =>
      a.relations.some((r) => r.targetTransactionId === before.id),
    )) {
      for (const relation of source.relations.filter((r) => r.targetTransactionId === before.id))
        invalid(
          relation.kind === 'refund_of'
            ? t.kind === 'expense' && t.amountMinor > 0
            : t.kind === 'transfer',
          'This edit would invalidate an incoming transaction relation. Change the relation explicitly first.',
        )
    }
  }
}
export function transactionPlan(
  c: Readonly<DomainContext>,
  before: Transaction | null,
  after: Transaction | null,
  token: string,
) {
  if (after) validateTransaction(after, c, before)
  const previous = effects(before, c.accounts),
    next = effects(after, c.accounts)
  const ids = [...new Set([...previous.keys(), ...next.keys()])]
  const balances: BalanceChange[] = ids.map((accountId) => {
    const account = required(
      c.accounts.find((a) => a.id === accountId),
      accountId,
    )
    const resulting =
      BigInt(account.balanceMinor) -
      BigInt(previous.get(accountId) ?? 0) +
      BigInt(next.get(accountId) ?? 0)
    invalid(
      resulting >= BigInt(Number.MIN_SAFE_INTEGER) && resulting <= BigInt(Number.MAX_SAFE_INTEGER),
      'The resulting balance exceeds safe integer minor units.',
    )
    return {
      accountId,
      previousBalanceMinor: account.balanceMinor,
      resultingBalanceMinor: Number(resulting),
    }
  })
  const accounts = balances.map((b) => ({
    ...required(c.accounts.find((a) => a.id === b.accountId)),
    balanceMinor: b.resultingBalanceMinor,
    balanceRevision: token,
    hasTransactions: true,
  }))
  const snapshot = (
    t: Transaction | null,
    accountList: Account[],
    updated = false,
  ): TransactionSnapshot | null =>
    t
      ? {
          transaction: t,
          relatedTransactions: c.transactions
            .filter(
              (other) =>
                other.id !== t.id &&
                (t.relations.some((r) => r.targetTransactionId === other.id) ||
                  other.relations.some((r) => r.targetTransactionId === t.id)),
            )
            .map((other) =>
              updated ? (transactions.find((value) => value.id === other.id) ?? other) : other,
            ),
          accounts: accountList.filter((a) => accountIds(t).includes(a.id)),
          categories: c.categories.filter((a) => t.assignments.some((b) => b.categoryId === a.id)),
        }
      : null
  const transactions = after ? [after] : []
  const related = new Set(
    [...(before?.relations ?? []), ...(after?.relations ?? [])].map((r) => r.targetTransactionId),
  )
  for (const t of c.transactions) {
    if (t.id === before?.id || t.id === after?.id) continue
    const incoming = !after && t.relations.some((r) => r.targetTransactionId === before?.id)
    if (related.has(t.id) || incoming)
      transactions.push({
        ...t,
        revision: token,
        relations: incoming
          ? t.relations.filter((r) => r.targetTransactionId !== before?.id)
          : t.relations,
      })
  }
  return {
    changes: {
      accounts,
      transactions,
      ...(!after && before ? { deleteTransactionId: before.id } : {}),
    },
    before: snapshot(before, c.accounts),
    after: snapshot(after, accounts, true),
    balances,
    result: {
      changed: true,
      transaction: after ?? required(before),
      relatedTransactions: c.transactions.filter(
        (t) =>
          t.id !== (after ?? before)?.id &&
          (related.has(t.id) || t.relations.some((r) => r.targetTransactionId === before?.id)),
      ),
      balances,
      accounts,
      categories: c.categories.filter((a) =>
        (after ?? before)?.assignments.some((b) => b.categoryId === a.id),
      ),
    },
  }
}
