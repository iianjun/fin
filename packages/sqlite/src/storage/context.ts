import { and, eq, inArray, or, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { FinError } from '@fin/provider'
import type { DomainContext, ReadRequest, MutationRequest } from '@fin/provider'
import { readAccounts } from './accounts.js'
import { readTransactionContext } from './transactions.js'
import * as schema from './schema.js'

export function readContext(
  orm: BetterSQLite3Database,
  request: ReadRequest | MutationRequest,
): DomainContext {
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
    context.vaults = orm
      .select({
        id: schema.vaults.id,
        name: schema.vaults.name,
        revision: schema.vaults.revision,
        archived: schema.vaults.archived,
      })
      .from(schema.vaults)
      .all()
      .filter((v) => request.includeArchived || !v.archived)
    return context
  }
  context.vault =
    orm
      .select({
        id: schema.vaults.id,
        name: schema.vaults.name,
        revision: schema.vaults.revision,
        archived: schema.vaults.archived,
      })
      .from(schema.vaults)
      .where(eq(schema.vaults.id, request.vaultId))
      .get() ?? null
  if (!context.vault)
    throw new FinError(
      'NOT_FOUND',
      'Vault does not exist.',
      'List vaults or create a new vault.',
      'not_applied',
      { vaultId: request.vaultId },
    )
  context.settings =
    orm
      .select({
        revision: schema.settings.revision,
        incomeAccountId: schema.settings.incomeAccountId,
        expenseAccountId: schema.settings.expenseAccountId,
      })
      .from(schema.settings)
      .where(eq(schema.settings.vaultId, request.vaultId))
      .get() ?? null
  if (request.kind === 'category' || request.kind === 'categories') {
    const p = schema.categoryPaths
    let filter
    if (request.kind === 'categories')
      filter = and(
        request.id ? eq(p.id, request.id) : undefined,
        request.includeArchived ? undefined : eq(p.archived, false),
      )
    else if (request.kind === 'category') {
      const before = request.id
        ? orm
            .select()
            .from(p)
            .where(and(eq(p.vaultId, request.vaultId), eq(p.id, request.id)))
            .get()
        : undefined
      const parentId = request.parentId === undefined ? before?.parentId : request.parentId
      const parent = parentId
        ? orm
            .select()
            .from(p)
            .where(and(eq(p.vaultId, request.vaultId), eq(p.id, parentId)))
            .get()
        : undefined
      filter = or(
        request.id ? eq(p.id, request.id) : undefined,
        before
          ? sql`instr(${p.path},${before.path} || ' / ')=1 OR instr(${before.path},${p.path} || ' / ')=1`
          : undefined,
        parent
          ? sql`${p.id}=${parent.id} OR instr(${parent.path},${p.path} || ' / ')=1`
          : undefined,
        (request.name ?? before?.name) ? eq(p.name, request.name ?? before?.name ?? '') : undefined,
      )
    }
    context.categories = orm
      .select()
      .from(p)
      .where(and(eq(p.vaultId, request.vaultId), filter))
      .all()
      .map(({ vaultId: _vaultId, ...category }) => category)
  }
  if (request.kind === 'accounts' || request.kind === 'account' || request.kind === 'settings') {
    const filter =
      request.kind === 'account'
        ? or(
            request.id ? eq(schema.accounts.id, request.id) : undefined,
            request.name ? eq(schema.accounts.name, request.name) : undefined,
          )
        : request.kind === 'accounts'
          ? and(
              request.id ? eq(schema.accounts.id, request.id) : undefined,
              request.includeArchived ? undefined : eq(schema.accounts.archived, false),
            )
          : 'accountIds' in request
            ? inArray(schema.accounts.id, request.accountIds ?? [])
            : inArray(schema.accounts.id, [])
    context.accounts = readAccounts(orm, request.vaultId, filter)
  }
  if (request.kind === 'transaction' || request.kind === 'transactions')
    Object.assign(context, readTransactionContext(orm, request, context.settings))
  if (request.kind === 'history')
    context.records = orm
      .select()
      .from(schema.history)
      .where(
        and(
          eq(schema.history.vaultId, request.vaultId),
          request.targetId ? eq(schema.history.targetId, request.targetId) : undefined,
          request.id ? eq(schema.history.id, request.id) : undefined,
        ),
      )
      .orderBy(sql`rowid`)
      .limit(request.limit ?? 100)
      .offset(request.offset ?? 0)
      .all()
      .map((r) => r.payload)
  return context
}
