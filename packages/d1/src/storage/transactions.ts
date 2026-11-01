import { and, eq, inArray, or, gte, lte, isNull, sql } from 'drizzle-orm'
import type { SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy'
import { FinError } from '@fin/provider'
import type {
  DomainContext,
  MutationRequest,
  ReadRequest,
  Transaction,
  VaultSettings,
} from '@fin/provider'
import { readAccounts } from './accounts.js'
import * as schema from './schema.js'

async function readTransactions(
  orm: SqliteRemoteDatabase,
  vaultId: string,
  filter?: ReturnType<typeof eq>,
): Promise<Transaction[]> {
  const rows = await orm
    .select()
    .from(schema.transactions)
    .where(and(eq(schema.transactions.vaultId, vaultId), filter))
    .orderBy(schema.transactions.occurredOn, schema.transactions.id)
    .all()
  const ids = sql`(SELECT value FROM json_each(${JSON.stringify(rows.map((t) => t.id))}))`
  const assignments = await orm
    .select()
    .from(schema.assignments)
    .where(
      and(eq(schema.assignments.vaultId, vaultId), inArray(schema.assignments.transactionId, ids)),
    )
    .all()
  const relations = await orm
    .select()
    .from(schema.relations)
    .where(and(eq(schema.relations.vaultId, vaultId), inArray(schema.relations.sourceId, ids)))
    .all()
  return rows.map((row) => {
    for (const amount of [
      row.amountMinor,
      row.sourceAmountMinor,
      row.destinationAmountMinor,
      ...assignments.filter((a) => a.transactionId === row.id).map((a) => a.amountMinor),
    ]) {
      if (amount !== null && !Number.isSafeInteger(amount))
        throw new FinError(
          'STORAGE_FAILURE',
          'Stored amounts are not safe integer minor units.',
          'Ask the host to inspect database integrity.',
        )
    }
    const base = {
      id: row.id,
      revision: row.revision,
      occurredOn: row.occurredOn,
      memo: row.memo,
      assignments: assignments
        .filter((a) => a.transactionId === row.id)
        .map(({ categoryId, amountMinor, origin }) => ({ categoryId, amountMinor, origin })),
      relations: relations
        .filter((a) => a.sourceId === row.id)
        .map(({ kind, targetTransactionId }) => ({ kind, targetTransactionId })),
    }
    if (
      row.kind === 'transfer' &&
      row.sourceAccountId !== null &&
      row.sourceAmountMinor !== null &&
      row.destinationAccountId !== null &&
      row.destinationAmountMinor !== null
    )
      return {
        ...base,
        kind: row.kind,
        sourceAccountId: row.sourceAccountId,
        sourceAmountMinor: row.sourceAmountMinor,
        destinationAccountId: row.destinationAccountId,
        destinationAmountMinor: row.destinationAmountMinor,
      }
    if (row.kind !== 'transfer' && row.accountId !== null && row.amountMinor !== null)
      return { ...base, kind: row.kind, accountId: row.accountId, amountMinor: row.amountMinor }
    throw new FinError(
      'STORAGE_FAILURE',
      'Stored transaction has an invalid shape.',
      'Ask the host to inspect database integrity.',
    )
  })
}

export async function readTransactionContext(
  orm: SqliteRemoteDatabase,
  request: Extract<ReadRequest | MutationRequest, { kind: 'transaction' | 'transactions' }>,
  settings: VaultSettings | null,
) {
  const context: Pick<DomainContext, 'accounts' | 'categories' | 'transactions' | 'records'> = {
    accounts: [],
    categories: [],
    transactions: [],
    records: [],
  }
  const t = schema.transactions
  let recreated: Transaction | undefined
  if (request.kind === 'transaction' && request.recordId) {
    context.records = (
      await orm
        .select()
        .from(schema.history)
        .where(
          and(eq(schema.history.vaultId, request.vaultId), eq(schema.history.id, request.recordId)),
        )
        .all()
    ).map((r) => r.payload)
    const before = context.records[0]?.before
    if (before && 'transaction' in before) recreated = before.transaction
  }
  const ids =
    request.kind === 'transaction'
      ? [request.id, ...(request.relatedIds ?? [])].filter(
          (id): id is string => typeof id === 'string',
        )
      : []
  if (recreated) ids.push(...recreated.relations.map((r) => r.targetTransactionId))
  const filter =
    request.kind === 'transactions'
      ? and(
          request.filters?.id ? eq(t.id, request.filters.id) : undefined,
          request.filters?.accountId
            ? or(
                eq(t.accountId, request.filters.accountId),
                eq(t.sourceAccountId, request.filters.accountId),
                eq(t.destinationAccountId, request.filters.accountId),
              )
            : undefined,
          request.filters?.kinds ? inArray(t.kind, request.filters.kinds) : undefined,
          request.filters?.dateFrom ? gte(t.occurredOn, request.filters.dateFrom) : undefined,
          request.filters?.dateTo ? lte(t.occurredOn, request.filters.dateTo) : undefined,
        )
      : or(
          inArray(t.id, sql`(SELECT value FROM json_each(${JSON.stringify([...new Set(ids)])}))`),
          request.id
            ? inArray(
                t.id,
                orm
                  .select({ id: schema.relations.sourceId })
                  .from(schema.relations)
                  .where(
                    and(
                      eq(schema.relations.vaultId, request.vaultId),
                      eq(schema.relations.targetTransactionId, request.id),
                    ),
                  ),
              )
            : undefined,
          request.id
            ? inArray(
                t.id,
                orm
                  .select({ id: schema.relations.targetTransactionId })
                  .from(schema.relations)
                  .where(
                    and(
                      eq(schema.relations.vaultId, request.vaultId),
                      eq(schema.relations.sourceId, request.id),
                    ),
                  ),
              )
            : undefined,
          request.duplicate
            ? and(
                eq(t.kind, request.duplicate.kind),
                eq(t.occurredOn, request.duplicate.occurredOn),
                request.duplicate.memo === null
                  ? isNull(t.memo)
                  : eq(t.memo, request.duplicate.memo),
                request.duplicate.kind === 'transfer'
                  ? and(
                      eq(t.sourceAccountId, request.duplicate.sourceAccountId),
                      eq(t.sourceAmountMinor, request.duplicate.sourceAmountMinor),
                      eq(t.destinationAccountId, request.duplicate.destinationAccountId),
                      eq(t.destinationAmountMinor, request.duplicate.destinationAmountMinor),
                    )
                  : and(
                      eq(
                        t.accountId,
                        request.duplicate.accountId ??
                          (request.duplicate.kind === 'income'
                            ? settings?.incomeAccountId
                            : settings?.expenseAccountId) ??
                          '',
                      ),
                      eq(t.amountMinor, request.duplicate.amountMinor),
                    ),
              )
            : undefined,
        )
  context.transactions = await readTransactions(orm, request.vaultId, filter)
  const accountIds = context.transactions.flatMap((t) =>
    t.kind === 'transfer' ? [t.sourceAccountId, t.destinationAccountId] : [t.accountId],
  )
  if (recreated)
    accountIds.push(
      ...(recreated.kind === 'transfer'
        ? [recreated.sourceAccountId, recreated.destinationAccountId]
        : [recreated.accountId]),
    )
  if (request.kind === 'transaction')
    accountIds.push(
      ...(request.accountIds ?? []),
      ...[settings?.incomeAccountId, settings?.expenseAccountId].filter(
        (id): id is string => typeof id === 'string',
      ),
    )
  context.accounts = await readAccounts(
    orm,
    request.vaultId,
    inArray(
      schema.accounts.id,
      sql`(SELECT value FROM json_each(${JSON.stringify([...new Set(accountIds)])}))`,
    ),
  )
  const categoryIds = context.transactions.flatMap((t) => t.assignments.map((a) => a.categoryId))
  if (recreated) categoryIds.push(...recreated.assignments.map((a) => a.categoryId))
  if (request.kind === 'transaction') categoryIds.push(...(request.categoryIds ?? []))
  const selectedCategoryIds = sql`(SELECT value FROM json_each(${JSON.stringify([...new Set(categoryIds)])}))`
  const p = schema.categoryPaths
  context.categories = (
    await orm
      .select()
      .from(p)
      .where(
        and(
          eq(p.vaultId, request.vaultId),
          or(
            inArray(p.id, selectedCategoryIds),
            inArray(
              p.id,
              orm
                .select({ id: schema.categories.parentId })
                .from(schema.categories)
                .where(
                  and(
                    eq(schema.categories.vaultId, request.vaultId),
                    inArray(schema.categories.id, selectedCategoryIds),
                  ),
                ),
            ),
          ),
        ),
      )
      .all()
  ).map(({ vaultId: _vaultId, ...category }) => category)
  // Reports need current ancestor paths, not historical display names.
  if (request.kind === 'transactions') {
    context.categories = (
      await orm.select().from(p).where(eq(p.vaultId, request.vaultId)).all()
    ).map(({ vaultId: _vaultId, ...category }) => category)
    const filters = request.filters
    if (filters?.categoryId && !context.categories.some((c) => c.id === filters.categoryId))
      throw new FinError(
        'NOT_FOUND',
        'Category does not exist in this vault.',
        'List categories and use an existing ID.',
      )
    const selected = context.categories.find((c) => c.id === filters?.categoryId)
    context.transactions = context.transactions
      .filter((transaction) => {
        const categories = context.categories.filter((c) =>
          transaction.assignments.some((a) => a.categoryId === c.id),
        )
        if (
          selected &&
          !categories.some((c) => c.id === selected.id || c.path.startsWith(`${selected.path} / `))
        )
          return false
        const text = filters?.search?.toLocaleLowerCase()
        return (
          !text ||
          [transaction.memo ?? '', ...categories.map((c) => c.path)].some((value) =>
            value.toLocaleLowerCase().includes(text),
          )
        )
      })
      .slice(
        filters?.offset ?? 0,
        filters?.limit === undefined ? undefined : (filters.offset ?? 0) + filters.limit,
      )
  }
  return context
}
