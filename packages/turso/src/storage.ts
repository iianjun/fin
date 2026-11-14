import { z } from 'zod'
import { FinError } from '@fin-kit/provider'
import type {
  DomainContext,
  DomainChanges,
  MutationRequest,
  ReadRequest,
  ChangeRecord,
} from '@fin-kit/provider'
import { isProjection, isWrite, type OperationSession, type SqlValue } from './session.js'

// These schemas validate both database projections and caller-supplied plans.
// Never cast JSON/protocol values into financial types or silently strip fields.
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
const changeRecord = z.strictObject({
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
const changesSchema = z.strictObject({
  vault: vault.optional(),
  settings: settings.optional(),
  accounts: z.array(account).optional(),
  categories: z.array(category).optional(),
  transactions: z.array(transaction).optional(),
  deleteTransactionId: text.optional(),
})
const sqlMinor = z
  .bigint()
  .refine((v) => v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER))
  .transform(Number)
const sqlBoolean = z.preprocess((v) => (v === 0n ? false : v === 1n ? true : v), z.boolean())

// Fixed column lists and schemas catch missing, renamed, duplicated and malformed
// context fields before the decision. All SQL values stay bound, never interpolated.
async function rows<S extends z.ZodType>(
  tx: OperationSession,
  table: string,
  columns: readonly string[],
  shape: S,
  vaultId?: string,
  orderBy?: string,
): Promise<z.output<S>[]> {
  const result = await tx.execute(
    `SELECT ${columns.join(',')} FROM ${table}${vaultId === undefined ? '' : ' WHERE vaultId=?'}${orderBy === undefined ? '' : ` ORDER BY ${orderBy}`}`,
    vaultId === undefined ? [] : [vaultId],
  )
  if (!isProjection(result, columns)) throw new Error('Invalid context columns')
  return result.rows.map((row) =>
    shape.parse(Object.fromEntries(columns.map((key, i) => [key, row[i]]))),
  )
}

export async function readContext(
  tx: OperationSession,
  request: ReadRequest | MutationRequest,
): Promise<DomainContext> {
  const context: DomainContext = {
    vault: null,
    vaults: [],
    settings: null,
    accounts: [],
    categories: [],
    transactions: [],
    records: [],
  }
  if (request.kind === 'createVault') return context
  if (request.kind === 'vaults') {
    context.vaults = (
      await rows(
        tx,
        'fin_vaults',
        ['id', 'name', 'revision', 'archived'],
        vault.extend({ archived: sqlBoolean }),
      )
    ).filter((v) => request.includeArchived || !v.archived)
    return context
  }
  const found = await tx.execute('SELECT id,name,revision,archived FROM fin_vaults WHERE id=?', [
    request.vaultId,
  ])
  if (!isProjection(found, ['id', 'name', 'revision', 'archived']) || found.rows.length > 1)
    throw new Error('Invalid Vault projection')
  const row = found.rows[0]
  if (!row)
    throw new FinError(
      'NOT_FOUND',
      'Vault does not exist.',
      'List vaults or create a new vault.',
      'not_applied',
      { vaultId: request.vaultId },
    )
  if (row[0] !== request.vaultId) throw new Error('Mismatched Vault identity')
  context.vault = vault
    .extend({ archived: sqlBoolean })
    .parse({ id: row[0], name: row[1], revision: row[2], archived: row[3] })
  const settingRows = await rows(
    tx,
    'fin_settings',
    ['revision', 'incomeAccountId', 'expenseAccountId'],
    settings,
    request.vaultId,
  )
  if (settingRows.length !== 1) throw new Error('Missing or duplicated settings')
  context.settings = settingRows[0] ?? null
  if (request.kind === 'vault') return context
  if (request.kind === 'history' || (request.kind === 'transaction' && request.recordId)) {
    const records = await rows(
      tx,
      'fin_change_records',
      ['id', 'targetId', 'payload'],
      z.strictObject({ id: text, targetId: text, payload: z.string() }),
      request.vaultId,
      'rowid',
    )
    context.records = records
      .map((r) => {
        const value: unknown = JSON.parse(r.payload)
        const record = changeRecord.parse(value)
        if (
          record.id !== r.id ||
          record.targetId !== r.targetId ||
          record.vaultId !== request.vaultId
        )
          throw new Error('Inconsistent history identity')
        return record
      })
      .filter((r) =>
        request.kind === 'history'
          ? (!request.id || r.id === request.id) &&
            (!request.targetId || r.targetId === request.targetId)
          : r.id === request.recordId,
      )
    if (request.kind === 'history') {
      context.records = context.records.slice(
        request.offset ?? 0,
        (request.offset ?? 0) + (request.limit ?? 100),
      )
      return context
    }
  }
  // Complete Vault dependencies rather than speculative request-specific filters.
  // BEGIN IMMEDIATE protects absent rows, names, relationships and aggregates too.
  const accounts = await rows(
    tx,
    'fin_accounts',
    [
      'id',
      'revision',
      'balanceRevision',
      'name',
      'nature',
      'currency',
      'archived',
      'hasTransactions',
    ],
    account
      .omit({ balanceMinor: true })
      .extend({ archived: sqlBoolean, hasTransactions: sqlBoolean }),
    request.vaultId,
  )
  const categories = await rows(
    tx,
    'fin_categories',
    ['id', 'revision', 'name', 'parentId', 'archived'],
    category.omit({ path: true }).extend({ archived: sqlBoolean }),
    request.vaultId,
  )
  const stored = await rows(
    tx,
    'fin_transactions',
    [
      'id',
      'revision',
      'kind',
      'occurredOn',
      'memo',
      'accountId',
      'amountMinor',
      'sourceAccountId',
      'sourceAmountMinor',
      'destinationAccountId',
      'destinationAmountMinor',
    ],
    z.strictObject({
      id: text,
      revision: text,
      kind: z.enum(['income', 'expense', 'adjustment', 'transfer']),
      occurredOn: text,
      memo: z.string().nullable(),
      accountId: text.nullable(),
      amountMinor: sqlMinor.nullable(),
      sourceAccountId: text.nullable(),
      sourceAmountMinor: sqlMinor.nullable(),
      destinationAccountId: text.nullable(),
      destinationAmountMinor: sqlMinor.nullable(),
    }),
    request.vaultId,
    'occurredOn,id',
  )
  const assignments = await rows(
    tx,
    'fin_category_assignments',
    ['transactionId', 'categoryId', 'amountMinor', 'origin'],
    z.strictObject({
      transactionId: text,
      categoryId: text,
      amountMinor: sqlMinor,
      origin: z.enum(['explicit', 'inferred']),
    }),
    request.vaultId,
  )
  const relations = await rows(
    tx,
    'fin_transaction_relations',
    ['sourceId', 'targetTransactionId', 'kind'],
    z.strictObject({
      sourceId: text,
      targetTransactionId: text,
      kind: z.enum(['refund_of', 'fee_for']),
    }),
    request.vaultId,
  )
  const ids = new Set(stored.map((t) => t.id))
  if (
    ids.size !== stored.length ||
    new Set(accounts.map((a) => a.id)).size !== accounts.length ||
    new Set(categories.map((c) => c.id)).size !== categories.length ||
    assignments.some(
      (a) => !ids.has(a.transactionId) || !categories.some((c) => c.id === a.categoryId),
    ) ||
    relations.some((r) => !ids.has(r.sourceId) || !ids.has(r.targetTransactionId))
  )
    throw new Error('Invalid Vault dependencies')
  context.transactions = stored.map((t) => {
    const base = {
      id: t.id,
      revision: t.revision,
      kind: t.kind,
      occurredOn: t.occurredOn,
      memo: t.memo,
      assignments: assignments
        .filter((a) => a.transactionId === t.id)
        .map((a) => ({ categoryId: a.categoryId, amountMinor: a.amountMinor, origin: a.origin })),
      relations: relations
        .filter((r) => r.sourceId === t.id)
        .map((r) => ({ kind: r.kind, targetTransactionId: r.targetTransactionId })),
    }
    if (t.kind === 'transfer') {
      if (t.accountId !== null || t.amountMinor !== null) throw new Error('Invalid transfer')
      return transaction.parse({
        ...base,
        sourceAccountId: t.sourceAccountId,
        sourceAmountMinor: t.sourceAmountMinor,
        destinationAccountId: t.destinationAccountId,
        destinationAmountMinor: t.destinationAmountMinor,
      })
    }
    if (
      t.sourceAccountId !== null ||
      t.sourceAmountMinor !== null ||
      t.destinationAccountId !== null ||
      t.destinationAmountMinor !== null
    )
      throw new Error('Invalid transaction')
    return transaction.parse({ ...base, accountId: t.accountId, amountMinor: t.amountMinor })
  })
  const balances = new Map(accounts.map((a) => [a.id, 0n]))
  for (const t of context.transactions) {
    const movements: [string, bigint][] =
      t.kind === 'transfer'
        ? [
            [t.sourceAccountId, -BigInt(t.sourceAmountMinor)],
            [t.destinationAccountId, BigInt(t.destinationAmountMinor)],
          ]
        : [[t.accountId, BigInt(t.amountMinor) * (t.kind === 'expense' ? -1n : 1n)]]
    for (const [id, movement] of movements) {
      const a = accounts.find((a) => a.id === id)
      const before = balances.get(id)
      if (!a || before === undefined) throw new Error('Missing account dependency')
      // Adjustments express a change to the displayed balance for both natures.
      balances.set(
        id,
        before + movement * (t.kind === 'adjustment' || a.nature === 'asset' ? 1n : -1n),
      )
    }
  }
  context.accounts = accounts.map((a) =>
    account.parse({ ...a, balanceMinor: sqlMinor.parse(balances.get(a.id)) }),
  )
  context.categories = await rows(
    tx,
    'fin_category_paths',
    ['id', 'revision', 'name', 'parentId', 'archived', 'path'],
    category.extend({ archived: sqlBoolean }),
    request.vaultId,
  )
  // The bounded view must cover every stored category once. Cycles, dangling
  // parents or depth beyond core's three levels cannot disappear as empty data.
  if (
    context.categories.length !== categories.length ||
    new Set(context.categories.map((c) => c.id)).size !== categories.length ||
    context.categories.some(
      (c) =>
        !categories.some(
          (raw) =>
            raw.id === c.id &&
            raw.revision === c.revision &&
            raw.parentId === c.parentId &&
            raw.name === c.name &&
            raw.archived === c.archived,
        ),
    )
  )
    throw new Error('Invalid category hierarchy')
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
    const filters = request.filters
    const selected = context.categories.find((c) => c.id === filters?.categoryId)
    if (filters?.categoryId && !selected)
      throw new FinError(
        'NOT_FOUND',
        'Category does not exist in this vault.',
        'List categories and use an existing ID.',
      )
    context.transactions = context.transactions
      .filter((t) => {
        const assigned = context.categories.filter((c) =>
          t.assignments.some((a) => a.categoryId === c.id),
        )
        const search = filters?.search?.toLocaleLowerCase()
        return (
          (!filters?.id || t.id === filters.id) &&
          (!filters?.accountId ||
            (t.kind === 'transfer'
              ? [t.sourceAccountId, t.destinationAccountId].includes(filters.accountId)
              : t.accountId === filters.accountId)) &&
          (!filters?.kinds || filters.kinds.includes(t.kind)) &&
          (!filters?.dateFrom || t.occurredOn >= filters.dateFrom) &&
          (!filters?.dateTo || t.occurredOn <= filters.dateTo) &&
          (!selected ||
            assigned.some(
              (c) => c.id === selected.id || c.path.startsWith(`${selected.path} / `),
            )) &&
          (!search ||
            [t.memo ?? '', ...assigned.map((c) => c.path)].some((s) =>
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
      .slice(
        filters?.offset ?? 0,
        filters?.limit === undefined ? undefined : (filters.offset ?? 0) + filters.limit,
      )
  }
  return context
}

async function apply(
  tx: OperationSession,
  sql: string,
  args: SqlValue[],
  expectedRows?: number,
): Promise<void> {
  if (!isWrite(await tx.execute(sql, args), expectedRows))
    throw new Error('Mutation receipt does not confirm the expected write')
}

export async function writeChanges(
  tx: OperationSession,
  request: MutationRequest,
  supplied: DomainChanges,
  record: ChangeRecord,
): Promise<void> {
  // Validate without replacing the original Change Record, including snapshots,
  // supplied revisions, order and optional settings. Store it exactly once.
  const changes = changesSchema.parse(supplied)
  changeRecord.parse(record)
  if (
    (request.kind !== 'createVault' && record.vaultId !== request.vaultId) ||
    (changes.vault && changes.vault.id !== record.vaultId) ||
    (request.kind === 'createVault' && (!changes.vault || !changes.settings))
  )
    throw new Error('Invalid mutation scope')
  if (changes.vault) {
    const v = changes.vault
    if (request.kind === 'createVault')
      await apply(
        tx,
        'INSERT INTO fin_vaults (id,name,revision,archived,generation,stamp) VALUES (?,?,?,?,?,0)',
        [v.id, v.name, v.revision, Number(v.archived), crypto.randomUUID()],
        1,
      )
    else
      await apply(
        tx,
        'UPDATE fin_vaults SET name=?,revision=?,archived=? WHERE id=?',
        [v.name, v.revision, Number(v.archived), v.id],
        1,
      )
  }
  // One checked statement per row; every row and history stays in the same
  // transaction. Do not infer success from a complete but non-applying result.
  const plans: { table: string; columns: string[]; values: SqlValue[]; key: string[] }[] = []
  if (changes.settings) {
    const s = changes.settings
    plans.push({
      table: 'fin_settings',
      columns: ['vaultId', 'revision', 'incomeAccountId', 'expenseAccountId'],
      values: [record.vaultId, s.revision, s.incomeAccountId, s.expenseAccountId],
      key: ['vaultId'],
    })
  }
  for (const a of changes.accounts ?? [])
    plans.push({
      table: 'fin_accounts',
      columns: [
        'vaultId',
        'id',
        'revision',
        'balanceRevision',
        'name',
        'nature',
        'currency',
        'archived',
        'hasTransactions',
      ],
      values: [
        record.vaultId,
        a.id,
        a.revision,
        a.balanceRevision,
        a.name,
        a.nature,
        a.currency,
        Number(a.archived),
        Number(a.hasTransactions),
      ],
      key: ['vaultId', 'id'],
    })
  for (const c of changes.categories ?? [])
    plans.push({
      table: 'fin_categories',
      columns: ['vaultId', 'id', 'revision', 'name', 'parentId', 'archived'],
      values: [record.vaultId, c.id, c.revision, c.name, c.parentId, Number(c.archived)],
      key: ['vaultId', 'id'],
    })
  for (const t of changes.transactions ?? [])
    plans.push({
      table: 'fin_transactions',
      columns: [
        'vaultId',
        'id',
        'revision',
        'kind',
        'occurredOn',
        'memo',
        'accountId',
        'amountMinor',
        'sourceAccountId',
        'sourceAmountMinor',
        'destinationAccountId',
        'destinationAmountMinor',
      ],
      values: [
        record.vaultId,
        t.id,
        t.revision,
        t.kind,
        t.occurredOn,
        t.memo,
        ...(t.kind === 'transfer'
          ? [
              null,
              null,
              t.sourceAccountId,
              t.sourceAmountMinor,
              t.destinationAccountId,
              t.destinationAmountMinor,
            ]
          : [t.accountId, t.amountMinor, null, null, null, null]),
      ],
      key: ['vaultId', 'id'],
    })
  for (const p of plans) {
    await apply(
      tx,
      `INSERT INTO ${p.table} (${p.columns.join(',')}) VALUES (${p.columns.map(() => '?').join(',')}) ON CONFLICT(${p.key.join(',')}) DO UPDATE SET ${p.columns
        .filter((c) => !p.key.includes(c))
        .map((c) => `${c}=excluded.${c}`)
        .join(',')}`,
      p.values,
      1,
    )
  }
  for (const t of changes.transactions ?? []) {
    await apply(tx, 'DELETE FROM fin_category_assignments WHERE vaultId=? AND transactionId=?', [
      record.vaultId,
      t.id,
    ])
    await apply(tx, 'DELETE FROM fin_transaction_relations WHERE vaultId=? AND sourceId=?', [
      record.vaultId,
      t.id,
    ])
    for (const a of t.assignments) {
      await apply(
        tx,
        'INSERT INTO fin_category_assignments (vaultId,transactionId,categoryId,amountMinor,origin) VALUES (?,?,?,?,?)',
        [record.vaultId, t.id, a.categoryId, a.amountMinor, a.origin],
        1,
      )
    }
    for (const r of t.relations) {
      await apply(
        tx,
        'INSERT INTO fin_transaction_relations (vaultId,sourceId,targetTransactionId,kind) VALUES (?,?,?,?)',
        [record.vaultId, t.id, r.targetTransactionId, r.kind],
        1,
      )
    }
  }
  if (changes.deleteTransactionId) {
    await apply(
      tx,
      'DELETE FROM fin_transactions WHERE vaultId=? AND id=?',
      [record.vaultId, changes.deleteTransactionId],
      1,
    )
  }
  await apply(
    tx,
    'INSERT INTO fin_change_records (vaultId,id,targetId,payload) VALUES (?,?,?,?)',
    [record.vaultId, record.id, record.targetId, JSON.stringify(record)],
    1,
  )
  await apply(tx, 'UPDATE fin_vaults SET stamp=stamp+1 WHERE id=?', [record.vaultId], 1)
}
