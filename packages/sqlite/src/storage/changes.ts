import { and, eq, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { ChangeRecord, DomainChanges, MutationRequest } from '@fin/provider'
import * as schema from './schema.js'

// The adapter calls this inside its write transaction after the single decision.
export function writeChanges(
  orm: BetterSQLite3Database,
  request: MutationRequest,
  changes: DomainChanges,
  record: ChangeRecord,
) {
  if (changes.vault) {
    if (request.kind === 'createVault')
      orm
        .insert(schema.vaults)
        .values({ ...changes.vault, generation: crypto.randomUUID(), stamp: 0 })
        .run()
    else
      orm.update(schema.vaults).set(changes.vault).where(eq(schema.vaults.id, record.vaultId)).run()
  }
  if (changes.settings)
    orm
      .insert(schema.settings)
      .values({ ...changes.settings, vaultId: record.vaultId })
      .onConflictDoUpdate({ target: schema.settings.vaultId, set: changes.settings })
      .run()
  for (const account of changes.accounts ?? []) {
    const { balanceMinor: _balanceMinor, ...row } = account
    orm
      .insert(schema.accounts)
      .values({ ...row, vaultId: record.vaultId })
      .onConflictDoUpdate({
        target: [schema.accounts.vaultId, schema.accounts.id],
        set: row,
      })
      .run()
  }
  for (const category of changes.categories ?? []) {
    const { path: _path, ...row } = category
    orm
      .insert(schema.categories)
      .values({ ...row, vaultId: record.vaultId })
      .onConflictDoUpdate({
        target: [schema.categories.vaultId, schema.categories.id],
        set: row,
      })
      .run()
  }
  for (const transaction of changes.transactions ?? []) {
    const base = {
      vaultId: record.vaultId,
      id: transaction.id,
      revision: transaction.revision,
      kind: transaction.kind,
      occurredOn: transaction.occurredOn,
      memo: transaction.memo,
    }
    const row =
      transaction.kind === 'transfer'
        ? {
            ...base,
            accountId: null,
            amountMinor: null,
            sourceAccountId: transaction.sourceAccountId,
            sourceAmountMinor: transaction.sourceAmountMinor,
            destinationAccountId: transaction.destinationAccountId,
            destinationAmountMinor: transaction.destinationAmountMinor,
          }
        : {
            ...base,
            accountId: transaction.accountId,
            amountMinor: transaction.amountMinor,
            sourceAccountId: null,
            sourceAmountMinor: null,
            destinationAccountId: null,
            destinationAmountMinor: null,
          }
    orm
      .insert(schema.transactions)
      .values(row)
      .onConflictDoUpdate({
        target: [schema.transactions.vaultId, schema.transactions.id],
        set: row,
      })
      .run()
  }
  for (const transaction of changes.transactions ?? []) {
    orm
      .delete(schema.assignments)
      .where(
        and(
          eq(schema.assignments.vaultId, record.vaultId),
          eq(schema.assignments.transactionId, transaction.id),
        ),
      )
      .run()
    orm
      .delete(schema.relations)
      .where(
        and(
          eq(schema.relations.vaultId, record.vaultId),
          eq(schema.relations.sourceId, transaction.id),
        ),
      )
      .run()
    // Keep each statement below D1's parameter budget without splitting the commit.
    for (let offset = 0; offset < transaction.assignments.length; offset += 16) {
      orm
        .insert(schema.assignments)
        .values(
          transaction.assignments.slice(offset, offset + 16).map((a) => ({
            ...a,
            vaultId: record.vaultId,
            transactionId: transaction.id,
          })),
        )
        .run()
    }
    for (let offset = 0; offset < transaction.relations.length; offset += 16) {
      orm
        .insert(schema.relations)
        .values(
          transaction.relations
            .slice(offset, offset + 16)
            .map((r) => ({ ...r, vaultId: record.vaultId, sourceId: transaction.id })),
        )
        .run()
    }
  }
  if (changes.deleteTransactionId)
    orm
      .delete(schema.transactions)
      .where(
        and(
          eq(schema.transactions.vaultId, record.vaultId),
          eq(schema.transactions.id, changes.deleteTransactionId),
        ),
      )
      .run()
  orm
    .insert(schema.history)
    .values({
      vaultId: record.vaultId,
      id: record.id,
      targetId: record.targetId,
      payload: record,
    })
    .run()
  orm
    .update(schema.vaults)
    .set({ stamp: sql`${schema.vaults.stamp} + 1` })
    .where(eq(schema.vaults.id, record.vaultId))
    .run()
}
