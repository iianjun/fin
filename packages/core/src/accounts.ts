import type { Account, FinStorage, VaultSettings } from '@fin/provider'
import { change } from './change.js'
import { entityId, invalid, label, required, revision } from './validation.js'

export class Accounts {
  readonly #storage: FinStorage
  readonly #vaultId: string

  constructor(storage: FinStorage, vaultId: string) {
    this.#storage = storage
    this.#vaultId = vaultId
  }

  async getSettings() {
    return required(
      (await this.#storage.read({ kind: 'settings', vaultId: this.#vaultId })).settings,
    )
  }

  async listAccounts(options: { includeArchived?: boolean } = {}) {
    return (await this.#storage.read({ kind: 'accounts', vaultId: this.#vaultId, ...options }))
      .accounts
  }

  async getAccount({ id }: { id: string }) {
    entityId(id)
    return required(
      (
        await this.#storage.read({
          kind: 'accounts',
          vaultId: this.#vaultId,
          id,
          includeArchived: true,
        })
      ).accounts[0],
      id,
    )
  }

  async createAccount(input: { name: string; nature: Account['nature']; currency: string }) {
    const name = label(input.name),
      id = crypto.randomUUID()
    invalid(
      input.nature === 'asset' || input.nature === 'liability',
      'Account nature must be asset or liability.',
    )
    invalid(
      typeof input.currency === 'string' && /^[A-Z]{3}$/.test(input.currency),
      'Currency must be a three-letter uppercase code.',
    )
    return change(
      this.#storage,
      { kind: 'account', vaultId: this.#vaultId, name },
      'account',
      id,
      'created',
      (c, token) => {
        invalid(
          c.accounts.length === 0,
          'Account names must be unique, including archived accounts.',
        )
        const account: Account = {
          id,
          revision: token,
          balanceRevision: token,
          name,
          nature: input.nature,
          currency: input.currency,
          archived: false,
          hasTransactions: false,
          balanceMinor: 0,
        }
        return {
          changes: { accounts: [account] },
          before: null,
          after: account,
          result: { changed: true, account },
        }
      },
    )
  }

  async updateAccount(input: {
    id: string
    expectedRevision: string
    patch: Partial<Pick<Account, 'name' | 'nature' | 'currency' | 'archived'>>
  }) {
    const patch = { ...input.patch }
    if (patch.name !== undefined) patch.name = label(patch.name)
    return change<{ changed: boolean; account: Account }>(
      this.#storage,
      { kind: 'account', vaultId: this.#vaultId, id: input.id, name: patch.name },
      'account',
      input.id,
      'updated',
      (c, token) => {
        const before = required(
          c.accounts.find((a) => a.id === input.id),
          input.id,
        )
        revision(before.revision, input.expectedRevision)
        const account = { ...before, ...patch }
        invalid(
          account.nature === 'asset' || account.nature === 'liability',
          'Account nature must be asset or liability.',
        )
        invalid(
          /^[A-Z]{3}$/.test(account.currency),
          'Currency must be a three-letter uppercase code.',
        )
        invalid(typeof account.archived === 'boolean', 'Archived must be a boolean.')
        invalid(
          !before.hasTransactions ||
            (account.nature === before.nature && account.currency === before.currency),
          'Currency and nature cannot change after the first transaction.',
        )
        invalid(
          !account.archived || account.balanceMinor === 0,
          'Only a zero-balance account can be archived.',
        )
        invalid(
          !c.accounts.some((a) => a.id !== account.id && a.name === account.name),
          'Account names must be unique, including archived accounts.',
        )
        if (JSON.stringify(account) === JSON.stringify(before))
          return { unchanged: { changed: false, account: before } }
        account.revision = token
        const settings = required(c.settings)
        const defaultsChanged =
          account.archived &&
          (settings.incomeAccountId === account.id || settings.expenseAccountId === account.id)
        return {
          changes: {
            accounts: [account],
            ...(defaultsChanged
              ? {
                  settings: {
                    ...settings,
                    revision: token,
                    incomeAccountId:
                      settings.incomeAccountId === account.id ? null : settings.incomeAccountId,
                    expenseAccountId:
                      settings.expenseAccountId === account.id ? null : settings.expenseAccountId,
                  },
                }
              : {}),
          },
          before,
          after: account,
          result: { changed: true, account },
        }
      },
    )
  }

  async setDefaultAccount(input: {
    kind: 'income' | 'expense'
    accountId: string | null
    expectedRevision: string
  }) {
    invalid(
      input.kind === 'income' || input.kind === 'expense',
      'Default account kind must be income or expense.',
    )
    return change<{ changed: boolean; settings: VaultSettings }>(
      this.#storage,
      {
        kind: 'settings',
        vaultId: this.#vaultId,
        accountIds: input.accountId ? [input.accountId] : [],
      },
      'settings',
      this.#vaultId,
      'updated',
      (c, token) => {
        const before = required(c.settings)
        revision(before.revision, input.expectedRevision)
        if (input.accountId !== null)
          invalid(
            !required(
              c.accounts.find((a) => a.id === input.accountId),
              input.accountId,
            ).archived,
            'An archived account cannot be a default.',
          )
        const key = input.kind === 'income' ? 'incomeAccountId' : 'expenseAccountId'
        if (before[key] === input.accountId)
          return { unchanged: { changed: false, settings: before } }
        const settings = { ...before, [key]: input.accountId, revision: token }
        return {
          changes: { settings },
          before,
          after: settings,
          result: { changed: true, settings },
        }
      },
    )
  }
}
