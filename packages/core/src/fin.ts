import type { ChangeRecord, FinStorage, Vault, VaultSettings } from '@fin/provider'
import { FinError } from '@fin/provider'
import { Accounts } from './accounts.js'
import { Categories } from './categories.js'
import { change } from './change.js'
import { Queries } from './queries.js'
import { Transactions } from './transactions.js'
import { invalid, label, required, revision } from './validation.js'

export async function createVault({ storage, name }: { storage: FinStorage; name: string }) {
  if (typeof name !== 'string' || !name.trim())
    throw new FinError('INVALID_INPUT', 'Vault name is required.', 'Provide a non-empty name.')
  const vault: Vault = {
    id: crypto.randomUUID(),
    revision: crypto.randomUUID(),
    name: name.trim(),
    archived: false,
  }
  const settings: VaultSettings = {
    revision: crypto.randomUUID(),
    incomeAccountId: null,
    expenseAccountId: null,
  }
  const record: ChangeRecord = {
    id: crypto.randomUUID(),
    vaultId: vault.id,
    target: 'vault',
    targetId: vault.id,
    action: 'created',
    recordedAt: new Date().toISOString(),
    before: null,
    after: vault,
    balances: [],
  }
  return storage.mutate({ kind: 'createVault' }, () => ({
    kind: 'changed',
    changes: { vault, settings },
    record,
    result: { changed: true, vault },
  }))
}

export async function listVaults({
  storage,
  includeArchived = false,
}: {
  storage: FinStorage
  includeArchived?: boolean
}) {
  return (await storage.read({ kind: 'vaults', includeArchived })).vaults
}

class VaultOperations {
  readonly #storage: FinStorage
  readonly #vaultId: string

  constructor(storage: FinStorage, vaultId: string) {
    this.#storage = storage
    this.#vaultId = vaultId
  }

  async updateVault(input: {
    expectedRevision: string
    patch: Partial<Pick<Vault, 'name' | 'archived'>>
  }) {
    const patch = { ...input.patch }
    if (patch.name !== undefined) patch.name = label(patch.name)
    return change<{ changed: boolean; vault: Vault }>(
      this.#storage,
      { kind: 'vault', vaultId: this.#vaultId },
      'vault',
      this.#vaultId,
      'updated',
      (c, token) => {
        const before = required(c.vault)
        revision(before.revision, input.expectedRevision)
        const vault = { ...before, ...patch }
        invalid(typeof vault.archived === 'boolean', 'Archived must be a boolean.')
        if (JSON.stringify(vault) === JSON.stringify(before))
          return { unchanged: { changed: false, vault: before } }
        vault.revision = token
        return { changes: { vault }, before, after: vault, result: { changed: true, vault } }
      },
    )
  }

  async getVault() {
    return required((await this.#storage.read({ kind: 'vault', vaultId: this.#vaultId })).vault)
  }
}

export function createFin({
  storage,
  vaultId,
  timeZone,
}: {
  storage: FinStorage
  vaultId: string
  timeZone?: string
}) {
  const transactions = new Transactions(storage, vaultId, timeZone)
  const vault = new VaultOperations(storage, vaultId)
  const accounts = new Accounts(storage, vaultId)
  const categories = new Categories(storage, vaultId)
  const queries = new Queries(storage, vaultId)
  return {
    updateVault: vault.updateVault.bind(vault),
    getVault: vault.getVault.bind(vault),
    getSettings: accounts.getSettings.bind(accounts),
    listAccounts: accounts.listAccounts.bind(accounts),
    getAccount: accounts.getAccount.bind(accounts),
    createAccount: accounts.createAccount.bind(accounts),
    updateAccount: accounts.updateAccount.bind(accounts),
    setDefaultAccount: accounts.setDefaultAccount.bind(accounts),
    listCategories: categories.listCategories.bind(categories),
    createCategory: categories.createCategory.bind(categories),
    updateCategory: categories.updateCategory.bind(categories),
    editTransaction: transactions.editTransaction.bind(transactions),
    recordTransfer: transactions.recordTransfer.bind(transactions),
    recordTransferFee: transactions.recordTransferFee.bind(transactions),
    adjustAccountBalance: transactions.adjustAccountBalance.bind(transactions),
    recordAdjustment: transactions.recordAdjustment.bind(transactions),
    setCategoryAssignments: transactions.setCategoryAssignments.bind(transactions),
    deleteTransaction: transactions.deleteTransaction.bind(transactions),
    recreateTransaction: transactions.recreateTransaction.bind(transactions),
    recordIncomeExpense: transactions.recordIncomeExpense.bind(transactions),
    recordRefund: transactions.recordRefund.bind(transactions),
    queryBalances: queries.queryBalances.bind(queries),
    getTransaction: queries.getTransaction.bind(queries),
    listTransactions: queries.listTransactions.bind(queries),
    queryTransactions: queries.queryTransactions.bind(queries),
    querySpending: queries.querySpending.bind(queries),
    listChangeRecords: queries.listChangeRecords.bind(queries),
  }
}

export type Fin = ReturnType<typeof createFin>
