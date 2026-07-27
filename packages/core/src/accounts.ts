import type { DatabaseSync } from 'node:sqlite'
import { withVaultDatabase } from './vault.js'

export type AccountNature = 'asset' | 'liability'
export type DefaultAccountKind = 'income' | 'expense'

export type Account = {
  id: number
  name: string
  nature: AccountNature
  currency: string
  archived: boolean
  balanceMinor: number
}

export type VaultSettings = {
  defaultIncomeAccountId: number | null
  defaultExpenseAccountId: number | null
}

export type AccountCreation = {
  name: string
  nature: AccountNature
  currency: string
}

export type CreateAccountResult = {
  action: 'created'
  account: Account
}

export type SetDefaultAccountResult = {
  action: 'updated'
  kind: DefaultAccountKind
  selectedAccount: Account | null
  settings: VaultSettings
}

type AccountRow = {
  id: number
  name: string
  nature: AccountNature
  currency: string
  archived_at: string | null
  balance_minor: number
}

type SettingsRow = {
  default_income_account_id: number | null
  default_expense_account_id: number | null
}

export function createAccount(vaultPath: string, creation: AccountCreation): CreateAccountResult {
  const name = normalizeAccountName(creation.name)
  const nature = validateAccountNature(creation.nature)
  const currency = normalizeCurrency(creation.currency)

  return withVaultDatabase(vaultPath, (database) =>
    runMutation(database, () => {
      const existingAccount = database
        .prepare(
          `SELECT id, name
           FROM accounts
           WHERE name = ? COLLATE NOCASE`,
        )
        .get(name) as { id: number; name: string } | undefined

      if (existingAccount) {
        throw new Error(
          `Account name "${name}" is already used by Account ${existingAccount.id} ` +
            `("${existingAccount.name}"). Choose a unique Account name.`,
        )
      }

      const accountId = Number(
        database
          .prepare(
            `INSERT INTO accounts (name, nature, currency)
             VALUES (?, ?, ?)`,
          )
          .run(name, nature, currency).lastInsertRowid,
      )
      const account = readAccount(database, accountId)

      insertChangeRecord(database, 'account', String(accountId), 'created', { account })

      return { action: 'created', account }
    }),
  )
}

export function listAccounts(vaultPath: string): Account[] {
  return withVaultDatabase(vaultPath, (database) => {
    const rows = database
      .prepare(
        `SELECT
           accounts.id,
           accounts.name,
           accounts.nature,
           accounts.currency,
           accounts.archived_at,
           account_balances.balance_minor
         FROM accounts
         JOIN account_balances ON account_balances.account_id = accounts.id
         ORDER BY accounts.id`,
      )
      .all() as AccountRow[]

    return rows.map(mapAccountRow)
  })
}

export function setDefaultAccount(
  vaultPath: string,
  kind: DefaultAccountKind,
  accountId: number | null,
): SetDefaultAccountResult {
  const validatedKind = validateDefaultAccountKind(kind)
  const validatedAccountId = accountId === null ? null : validateAccountId(accountId)

  return withVaultDatabase(vaultPath, (database) =>
    runMutation(database, () => {
      const previousSettings = readSettings(database)
      const selectedAccount =
        validatedAccountId === null ? null : readSelectableAccount(database, validatedAccountId)
      const column =
        validatedKind === 'income' ? 'default_income_account_id' : 'default_expense_account_id'

      database
        .prepare(
          `UPDATE vault_settings
           SET ${column} = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           WHERE singleton_id = 1`,
        )
        .run(validatedAccountId)

      const settings = readSettings(database)
      const previousAccountId =
        validatedKind === 'income'
          ? previousSettings.defaultIncomeAccountId
          : previousSettings.defaultExpenseAccountId

      insertChangeRecord(database, 'vault_settings', '1', 'updated', {
        kind: validatedKind,
        previousAccountId,
        accountId: validatedAccountId,
        settings,
      })

      return {
        action: 'updated',
        kind: validatedKind,
        selectedAccount,
        settings,
      }
    }),
  )
}

function normalizeAccountName(name: string): string {
  const normalizedName = name.trim()

  if (normalizedName.length === 0) {
    throw new Error('Account name must not be empty')
  }

  return normalizedName
}

function validateAccountNature(nature: AccountNature): AccountNature {
  if (nature !== 'asset' && nature !== 'liability') {
    throw new Error('Account nature must be either "asset" or "liability"')
  }

  return nature
}

function normalizeCurrency(currency: string): string {
  const normalizedCurrency = currency.trim().toUpperCase()

  if (!/^[A-Z]{3}$/.test(normalizedCurrency)) {
    throw new Error('Account currency must be a three-letter code such as KRW or USD')
  }

  return normalizedCurrency
}

function validateDefaultAccountKind(kind: DefaultAccountKind): DefaultAccountKind {
  if (kind !== 'income' && kind !== 'expense') {
    throw new Error('Default Account kind must be either "income" or "expense"')
  }

  return kind
}

function validateAccountId(accountId: number): number {
  if (!Number.isSafeInteger(accountId) || accountId <= 0) {
    throw new Error('Account ID must be a positive integer')
  }

  return accountId
}

function readSelectableAccount(database: DatabaseSync, accountId: number): Account {
  const account = readAccount(database, accountId)

  if (account.archived) {
    throw new Error(
      `Archived Account ${account.id} ("${account.name}") cannot be a default Account`,
    )
  }

  return account
}

function readAccount(database: DatabaseSync, accountId: number): Account {
  const row = database
    .prepare(
      `SELECT
         accounts.id,
         accounts.name,
         accounts.nature,
         accounts.currency,
         accounts.archived_at,
         account_balances.balance_minor
       FROM accounts
       JOIN account_balances ON account_balances.account_id = accounts.id
       WHERE accounts.id = ?`,
    )
    .get(accountId) as AccountRow | undefined

  if (!row) {
    throw new Error(`Account ${accountId} does not exist`)
  }

  return mapAccountRow(row)
}

function mapAccountRow(row: AccountRow): Account {
  return {
    id: row.id,
    name: row.name,
    nature: row.nature,
    currency: row.currency,
    archived: row.archived_at !== null,
    balanceMinor: row.balance_minor,
  }
}

function readSettings(database: DatabaseSync): VaultSettings {
  const row = database
    .prepare(
      `SELECT default_income_account_id, default_expense_account_id
       FROM vault_settings
       WHERE singleton_id = 1`,
    )
    .get() as SettingsRow | undefined

  if (!row) {
    throw new Error('Vault settings are missing')
  }

  return {
    defaultIncomeAccountId: row.default_income_account_id,
    defaultExpenseAccountId: row.default_expense_account_id,
  }
}

function insertChangeRecord(
  database: DatabaseSync,
  entityType: 'vault_settings' | 'account',
  entityId: string,
  action: 'created' | 'updated',
  payload: object,
): void {
  database
    .prepare(
      `INSERT INTO change_records (entity_type, entity_id, action, payload)
       VALUES (?, ?, ?, json(?))`,
    )
    .run(entityType, entityId, action, JSON.stringify(payload))
}

function runMutation<Result>(database: DatabaseSync, mutation: () => Result): Result {
  database.exec('BEGIN IMMEDIATE')

  try {
    const result = mutation()
    database.exec('COMMIT')
    return result
  } catch (error) {
    try {
      database.exec('ROLLBACK')
    } catch {
      // Preserve the mutation error if SQLite already rolled the transaction back.
    }

    throw error
  }
}
