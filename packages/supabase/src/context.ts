import { z } from 'zod'
import { FinError } from '@fin-kit/provider'
import type { DomainContext, ReadRequest, MutationRequest } from '@fin-kit/provider'

// Strict validation is adapter-local: the HTTP wire never becomes domain data by assertion.
const text = z.string().min(1)
const minor = z.number().int().safe()
const vault = z.strictObject({ id: text, name: text, revision: text, archived: z.boolean() })
const settings = z.strictObject({
  revision: text,
  incomeAccountId: text.nullable(),
  expenseAccountId: text.nullable(),
})
const account = z.strictObject({
  id: text,
  revision: text,
  balanceRevision: text,
  name: text,
  nature: z.enum(['asset', 'liability']),
  currency: z.string().regex(/^[A-Z]{3}$/),
  archived: z.boolean(),
  hasTransactions: z.boolean(),
  balanceMinor: minor,
})
const category = z.strictObject({
  id: text,
  revision: text,
  name: text,
  parentId: text.nullable(),
  path: text,
  archived: z.boolean(),
})
const transactionBase = {
  id: text,
  revision: text,
  occurredOn: text,
  memo: z.string().nullable(),
  assignments: z.array(
    z.strictObject({
      categoryId: text,
      amountMinor: minor,
      origin: z.enum(['explicit', 'inferred']),
    }),
  ),
  relations: z.array(
    z.strictObject({ kind: z.enum(['refund_of', 'fee_for']), targetTransactionId: text }),
  ),
}
const transaction = z.union([
  z.strictObject({
    ...transactionBase,
    kind: z.enum(['income', 'expense', 'adjustment']),
    accountId: text,
    amountMinor: minor,
  }),
  z.strictObject({
    ...transactionBase,
    kind: z.literal('transfer'),
    sourceAccountId: text,
    sourceAmountMinor: minor,
    destinationAccountId: text,
    destinationAmountMinor: minor,
  }),
])
const snapshot = z
  .union([
    vault,
    settings,
    account,
    category,
    z.strictObject({
      transaction,
      relatedTransactions: z.array(transaction),
      accounts: z.array(account),
      categories: z.array(category),
    }),
  ])
  .nullable()
export const changeRecord = z.strictObject({
  id: text,
  vaultId: text,
  target: z.enum(['vault', 'settings', 'account', 'category', 'transaction']),
  targetId: text,
  action: z.enum(['created', 'updated', 'deleted', 'recreated']),
  recordedAt: text,
  before: snapshot,
  after: snapshot,
  balances: z.array(
    z.strictObject({ accountId: text, previousBalanceMinor: minor, resultingBalanceMinor: minor }),
  ),
  settings: z.strictObject({ before: settings, after: settings }).optional(),
})
export const changesSchema = z.strictObject({
  vault: vault.optional(),
  settings: settings.optional(),
  accounts: z.array(account).optional(),
  categories: z.array(category).optional(),
  transactions: z.array(transaction).optional(),
  deleteTransactionId: text.optional(),
})

export const identity =
  'fin-supabase-v1:e1c7a08a530042615350af6cd5284c4e5c84e5570f341d059ead8b0a5f6accc8'
export const guardSchema = z.strictObject({
  generation: text,
  stamp: z.string().regex(/^(0|[1-9][0-9]*)$/),
})
export const receiptSchema = z.strictObject({
  identity: z.literal(identity),
  nonce: text,
  vaultId: text,
  recordId: text,
  generation: text,
  stamp: z.string().regex(/^[1-9][0-9]*$/),
})
const rawContext = z.strictObject({
  identity: z.literal(identity),
  nonce: text,
  kind: text,
  vaultId: text.nullable(),
  guard: guardSchema.nullable(),
  counts: z.strictObject({
    vaults: z.number().int().nonnegative().safe(),
    accounts: z.number().int().nonnegative().safe(),
    categories: z.number().int().nonnegative().safe(),
    transactions: z.number().int().nonnegative().safe(),
    records: z.number().int().nonnegative().safe(),
  }),
  context: z.strictObject({
    vault: vault.nullable(),
    vaults: z.array(vault),
    settings: settings.nullable(),
    accounts: z.array(account.omit({ balanceMinor: true })),
    categories: z.array(category.omit({ path: true })),
    transactions: z.array(transaction),
    records: z.array(changeRecord),
  }),
})

// A single RPC supplies raw dependencies at one snapshot. Derivation and projection
// stay local; SQL never evaluates product rules or constructs Change Records.
export function readContext(
  raw: unknown,
  request: ReadRequest | MutationRequest,
  nonce: string,
): {
  context: DomainContext
  guard: z.output<typeof guardSchema> | null
} {
  const parsed = rawContext.parse(raw)
  const scoped = 'vaultId' in request ? request.vaultId : null
  if (parsed.nonce !== nonce || parsed.kind !== request.kind || parsed.vaultId !== scoped)
    throw new Error('Mismatched context envelope')
  const data = parsed.context
  for (const key of ['vaults', 'accounts', 'categories', 'transactions', 'records'] as const)
    if (data[key].length !== parsed.counts[key]) throw new Error('Incomplete context arrays')
  const context: DomainContext = { ...data, accounts: [], categories: [] }
  // Identity sets also detect malformed duplicate rows before a decision.
  if (
    new Set(data.vaults.map((x) => x.id)).size !== data.vaults.length ||
    new Set(data.accounts.map((x) => x.id)).size !== data.accounts.length ||
    new Set(data.categories.map((x) => x.id)).size !== data.categories.length ||
    new Set(data.transactions.map((x) => x.id)).size !== data.transactions.length ||
    new Set(data.records.map((x) => x.id)).size !== data.records.length
  )
    throw new Error('Duplicate context identities')
  if (!scoped) {
    if (
      parsed.guard !== null ||
      data.vault !== null ||
      data.settings !== null ||
      data.accounts.length ||
      data.categories.length ||
      data.transactions.length ||
      data.records.length ||
      (request.kind === 'createVault' && data.vaults.length)
    )
      throw new Error('Invalid unscoped context')
    if (request.kind === 'vaults')
      context.vaults = data.vaults.filter((v) => request.includeArchived || !v.archived)
    return { context, guard: null }
  }
  if (
    data.vault?.id !== scoped ||
    !data.settings ||
    !parsed.guard ||
    data.vaults.length ||
    data.records.some((r) => r.vaultId !== scoped)
  )
    throw new Error('Incomplete or mismatched Vault context')
  const accounts = new Map(data.accounts.map((a) => [a.id, a]))
  const categories = new Map(data.categories.map((c) => [c.id, c]))
  const transactions = new Set(data.transactions.map((x) => x.id))
  const balances = new Map(data.accounts.map((a) => [a.id, 0n]))
  for (const id of [data.settings.incomeAccountId, data.settings.expenseAccountId])
    if (id !== null && !accounts.has(id)) throw new Error('Missing settings dependency')
  for (const t of data.transactions) {
    if (
      new Set(t.assignments.map((a) => a.categoryId)).size !== t.assignments.length ||
      t.assignments.some((a) => !categories.has(a.categoryId)) ||
      t.relations.some((r) => !transactions.has(r.targetTransactionId))
    )
      throw new Error('Missing transaction dependency')
    const movements: [string, bigint][] =
      t.kind === 'transfer'
        ? [
            [t.sourceAccountId, -BigInt(t.sourceAmountMinor)],
            [t.destinationAccountId, BigInt(t.destinationAmountMinor)],
          ]
        : [[t.accountId, BigInt(t.amountMinor) * (t.kind === 'expense' ? -1n : 1n)]]
    for (const [id, amount] of movements) {
      const a = accounts.get(id),
        before = balances.get(id)
      if (!a || before === undefined) throw new Error('Missing account dependency')
      balances.set(
        id,
        before + amount * (t.kind === 'adjustment' || a.nature === 'asset' ? 1n : -1n),
      )
    }
  }
  context.accounts = data.accounts.map((a) => {
    const balance = balances.get(a.id)
    if (
      balance === undefined ||
      balance < BigInt(Number.MIN_SAFE_INTEGER) ||
      balance > BigInt(Number.MAX_SAFE_INTEGER)
    )
      throw new Error('Unsafe aggregate balance')
    return { ...a, balanceMinor: Number(balance) }
  })
  context.categories = data.categories.map((c) => {
    const names = [c.name],
      seen = new Set([c.id])
    let parentId = c.parentId
    while (parentId !== null) {
      const parent = categories.get(parentId)
      if (!parent || seen.has(parentId) || names.length >= 3)
        throw new Error('Invalid category hierarchy')
      seen.add(parentId)
      names.unshift(parent.name)
      parentId = parent.parentId
    }
    return { ...c, path: names.join(' / ') }
  })
  if (request.kind === 'history') {
    context.records = context.records
      .filter(
        (r) =>
          (!request.id || r.id === request.id) &&
          (!request.targetId || r.targetId === request.targetId),
      )
      .slice(request.offset ?? 0, (request.offset ?? 0) + (request.limit ?? 100))
  } else if (request.kind === 'transaction' && request.recordId) {
    context.records = context.records.filter((r) => r.id === request.recordId)
  } else context.records = []
  if (request.kind === 'account')
    context.accounts = context.accounts.filter(
      (a) => a.id === request.id || a.name === request.name,
    )
  if (request.kind === 'accounts')
    context.accounts = context.accounts.filter(
      (a) => (!request.id || request.id === a.id) && (request.includeArchived || !a.archived),
    )
  if (request.kind === 'categories')
    context.categories = context.categories.filter(
      (c) => (!request.id || request.id === c.id) && (request.includeArchived || !c.archived),
    )
  if (request.kind === 'transactions') {
    const f = request.filters
    const selected = context.categories.find((c) => c.id === f?.categoryId)
    if (f?.categoryId && !selected)
      throw new FinError(
        'NOT_FOUND',
        'Category does not exist in this vault.',
        'List categories and use an existing ID.',
      )
    context.transactions = context.transactions
      .filter((t) => {
        const cats = context.categories.filter((c) =>
          t.assignments.some((a) => a.categoryId === c.id),
        )
        const search = f?.search?.toLocaleLowerCase()
        return (
          (!f?.id || t.id === f.id) &&
          (!f?.accountId ||
            (t.kind === 'transfer'
              ? [t.sourceAccountId, t.destinationAccountId].includes(f.accountId)
              : t.accountId === f.accountId)) &&
          (!f?.kinds || f.kinds.includes(t.kind)) &&
          (!f?.dateFrom || t.occurredOn >= f.dateFrom) &&
          (!f?.dateTo || t.occurredOn <= f.dateTo) &&
          (!selected ||
            cats.some((c) => c.id === selected.id || c.path.startsWith(`${selected.path} / `))) &&
          (!search ||
            [t.memo ?? '', ...cats.map((c) => c.path)].some((s) =>
              s.toLocaleLowerCase().includes(search),
            ))
        )
      })
      .sort((a, b) =>
        a.occurredOn < b.occurredOn
          ? -1
          : a.occurredOn > b.occurredOn
            ? 1
            : a.id < b.id
              ? -1
              : a.id > b.id
                ? 1
                : 0,
      )
      .slice(f?.offset ?? 0, f?.limit === undefined ? undefined : (f.offset ?? 0) + f.limit)
  }
  return { context, guard: parsed.guard }
}
