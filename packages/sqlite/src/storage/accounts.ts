import { and, eq, getTableColumns, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { FinError } from '@fin/provider'
import * as schema from './schema.js'

export function readAccounts(
  orm: BetterSQLite3Database,
  vaultId: string,
  filter?: ReturnType<typeof eq>,
) {
  return orm
    .select({
      ...getTableColumns(schema.accounts),
      balanceMinor: sql<number>`coalesce((SELECT sum(CASE WHEN t.kind='income' THEN t.amountMinor WHEN t.kind='expense' THEN -t.amountMinor WHEN t.kind='adjustment' THEN CASE WHEN fin_accounts.nature='asset' THEN t.amountMinor ELSE -t.amountMinor END WHEN t.kind='transfer' AND t.sourceAccountId=fin_accounts.id THEN -t.sourceAmountMinor ELSE t.destinationAmountMinor END) FROM fin_transactions t WHERE t.vaultId=fin_accounts.vaultId AND (t.accountId=fin_accounts.id OR t.sourceAccountId=fin_accounts.id OR t.destinationAccountId=fin_accounts.id)),0) * CASE WHEN fin_accounts.nature='asset' THEN 1 ELSE -1 END`,
    })
    .from(schema.accounts)
    .where(and(eq(schema.accounts.vaultId, vaultId), filter))
    .all()
    .map((a) => {
      if (!Number.isSafeInteger(a.balanceMinor))
        throw new FinError(
          'STORAGE_FAILURE',
          'An account balance exceeds safe integer minor units.',
          'Ask the host to inspect the stored amounts.',
        )
      const { vaultId: _vaultId, ...account } = a
      return account
    })
}
