import type { FinStorage, TransactionFilters } from '@fin/provider'
import { accountIds } from './transaction-plan.js'
import { entityId, money, queryFilters, required } from './validation.js'

export class Queries {
  readonly #storage: FinStorage
  readonly #vaultId: string

  constructor(storage: FinStorage, vaultId: string) {
    this.#storage = storage
    this.#vaultId = vaultId
  }

  async queryBalances() {
    const accounts = (
      await this.#storage.read({ kind: 'accounts', vaultId: this.#vaultId, includeArchived: true })
    ).accounts
    const totals = new Map<string, number>()
    for (const a of accounts)
      totals.set(
        a.currency,
        money((totals.get(a.currency) ?? 0) + a.balanceMinor * (a.nature === 'asset' ? 1 : -1)),
      )
    return {
      accounts,
      netWorthByCurrency: [...totals]
        .map(([currency, amountMinor]) => ({ currency, amountMinor }))
        .sort((a, b) => a.currency.localeCompare(b.currency)),
    }
  }

  async getTransaction({ id }: { id: string }) {
    entityId(id)
    return required(
      (
        await this.#storage.read({ kind: 'transactions', vaultId: this.#vaultId, filters: { id } })
      ).transactions.find((t) => t.id === id),
      id,
    )
  }

  async listTransactions(filters: TransactionFilters = {}) {
    return (
      await this.#storage.read({
        kind: 'transactions',
        vaultId: this.#vaultId,
        filters: queryFilters(filters),
      })
    ).transactions
  }

  async queryTransactions(filters: TransactionFilters = {}) {
    const c = await this.#storage.read({
      kind: 'transactions',
      vaultId: this.#vaultId,
      filters: queryFilters(filters),
    })
    const totals = new Map<string, { incomeMinor: number; expenseMinor: number }>()
    const transactions = c.transactions.map((transaction) => {
      const accounts = c.accounts.filter((a) => accountIds(transaction).includes(a.id))
      const categories = c.categories.filter((a) =>
        transaction.assignments.some((b) => b.categoryId === a.id),
      )
      if (transaction.kind === 'income' || transaction.kind === 'expense') {
        const currency = required(accounts[0]).currency,
          total = totals.get(currency) ?? { incomeMinor: 0, expenseMinor: 0 }
        if (transaction.kind === 'income')
          total.incomeMinor = money(total.incomeMinor + transaction.amountMinor)
        else total.expenseMinor = money(total.expenseMinor + transaction.amountMinor)
        totals.set(currency, total)
      }
      return { ...transaction, accounts, categories }
    })
    return {
      transactions,
      incomeExpenseTotalsByCurrency: [...totals]
        .map(([currency, t]) => ({
          currency,
          ...t,
          netIncomeMinor: money(t.incomeMinor - t.expenseMinor),
        }))
        .sort((a, b) => a.currency.localeCompare(b.currency)),
    }
  }

  async querySpending(filters: Omit<TransactionFilters, 'limit' | 'offset' | 'id' | 'kinds'> = {}) {
    const c = await this.#storage.read({
      kind: 'transactions',
      vaultId: this.#vaultId,
      filters: queryFilters({ ...filters, kinds: ['expense'] }),
    })
    const totals = new Map<string, number>(),
      uncategorized = new Map<string, number>()
    const rollups = new Map<
      string,
      { categoryId: string; categoryPath: string; currency: string; amountMinor: number }
    >()
    for (const transaction of c.transactions) {
      if (transaction.kind !== 'expense') continue
      const currency = required(c.accounts.find((a) => a.id === transaction.accountId)).currency
      totals.set(currency, money((totals.get(currency) ?? 0) + transaction.amountMinor))
      let assigned = 0
      for (const assignment of transaction.assignments) {
        assigned = money(assigned + assignment.amountMinor)
        const leaf = required(
          c.categories.find((a) => a.id === assignment.categoryId),
          assignment.categoryId,
        )
        const selected = filters.categoryId
          ? required(
              c.categories.find((a) => a.id === filters.categoryId),
              filters.categoryId,
            )
          : null
        if (selected && leaf.id !== selected.id && !leaf.path.startsWith(`${selected.path} / `))
          continue
        for (const category of c.categories.filter(
          (a) => leaf.id === a.id || leaf.path.startsWith(`${a.path} / `),
        )) {
          const key = `${category.id}:${currency}`,
            current = rollups.get(key) ?? {
              categoryId: category.id,
              categoryPath: category.path,
              currency,
              amountMinor: 0,
            }
          current.amountMinor = money(current.amountMinor + assignment.amountMinor)
          rollups.set(key, current)
        }
      }
      uncategorized.set(
        currency,
        money((uncategorized.get(currency) ?? 0) + money(transaction.amountMinor - assigned)),
      )
    }
    return {
      transactions: c.transactions,
      expenseTotalsByCurrency: [...totals]
        .map(([currency, amountMinor]) => ({ currency, amountMinor }))
        .sort((a, b) => a.currency.localeCompare(b.currency)),
      uncategorizedByCurrency: [...uncategorized]
        .map(([currency, amountMinor]) => ({ currency, amountMinor }))
        .sort((a, b) => a.currency.localeCompare(b.currency)),
      categoryRollups: [...rollups.values()].sort(
        (a, b) =>
          a.currency.localeCompare(b.currency) || a.categoryPath.localeCompare(b.categoryPath),
      ),
    }
  }

  async listChangeRecords(options: { targetId?: string; limit?: number; offset?: number } = {}) {
    queryFilters(options)
    return (await this.#storage.read({ kind: 'history', vaultId: this.#vaultId, ...options }))
      .records
  }
}
