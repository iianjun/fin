import { createFin, createVault } from '@fin/core'
import { createSqliteAdapter } from '@fin/sqlite'

const storage = createSqliteAdapter({ filename: ':memory:' })
try {
  const { vault } = await createVault({ storage, name: 'Household' })
  const fin = createFin({ storage, vaultId: vault.id, timeZone: 'Asia/Seoul' })
  const { account } = await fin.createAccount({ name: 'Cash', nature: 'asset', currency: 'KRW' })
  await fin.recordIncomeExpense({ kind: 'income', accountId: account.id, amountMinor: 10000 })
  const expense = await fin.recordIncomeExpense({
    kind: 'expense',
    accountId: account.id,
    amountMinor: 3000,
    memo: 'Coffee',
  })
  await fin.editTransaction({
    id: expense.transaction.id,
    expectedRevision: expense.transaction.revision,
    patch: { memo: 'Coffee with a friend' },
  })
  console.log(JSON.stringify(await fin.queryBalances(), null, 2))
} finally {
  await storage.close()
}
