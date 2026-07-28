import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { FinError } from './errors.js'

const databaseFileName = 'fin.sqlite'
const migrationsDirectory = new URL('../migrations/', import.meta.url)
const migrationFilePattern = /^(?<version>\d+)_[a-z0-9_]+\.sql$/

export type VaultState = {
  path: string
  databasePath: string
  schemaVersion: number
  settings: {
    defaultIncomeAccountId: number | null
    defaultExpenseAccountId: number | null
  }
  accountCount: number
  categoryCount: number
}

export function initializeVault(vaultPath: string): VaultState {
  const path = resolveVaultPath(vaultPath)
  const databasePath = resolve(path, databaseFileName)

  mkdirSync(path, { recursive: true })

  if (existsSync(databasePath)) {
    if (!isFinVaultDatabase(databasePath)) {
      throw createInvalidVaultError(path, databasePath)
    }

    throw new FinError('VAULT_ALREADY_EXISTS', `Vault already exists at ${path}`, { path })
  }

  const database = new DatabaseSync(databasePath)

  try {
    applyPendingMigrations(database)
    return readVaultState(database, path, databasePath)
  } catch (error) {
    database.close()
    rmSync(databasePath, { force: true })
    throw error
  } finally {
    if (database.isOpen) {
      database.close()
    }
  }
}

export function openVault(vaultPath: string): VaultState {
  return withVaultDatabase(vaultPath, (database, path, databasePath) =>
    readVaultState(database, path, databasePath),
  )
}

export function withVaultDatabase<Result>(
  vaultPath: string,
  operation: (database: DatabaseSync, path: string, databasePath: string) => Result,
): Result {
  const path = resolveVaultPath(vaultPath)
  const databasePath = resolve(path, databaseFileName)

  if (!existsSync(databasePath)) {
    throw new FinError('VAULT_NOT_FOUND', `Vault does not exist at ${path}`, { path })
  }

  let database: DatabaseSync

  try {
    database = new DatabaseSync(databasePath)
  } catch {
    throw createInvalidVaultError(path, databasePath)
  }

  try {
    let isFinVault: boolean

    try {
      isFinVault = hasMigrationsTable(database)
    } catch {
      throw createInvalidVaultError(path, databasePath)
    }

    if (!isFinVault) {
      throw createInvalidVaultError(path, databasePath)
    }

    database.exec('PRAGMA foreign_keys = ON')
    applyPendingMigrations(database)
    return operation(database, path, databasePath)
  } finally {
    database.close()
  }
}

function resolveVaultPath(vaultPath: string): string {
  if (vaultPath.trim().length === 0) {
    throw new FinError('INVALID_INPUT', 'Vault path must not be empty', { fields: ['path'] })
  }

  return resolve(vaultPath)
}

function applyPendingMigrations(database: DatabaseSync): void {
  const appliedVersions = readAppliedMigrationVersions(database)

  for (const migration of readMigrations()) {
    if (appliedVersions.has(migration.version)) {
      continue
    }

    database.exec(migration.sql)

    if (!readAppliedMigrationVersions(database).has(migration.version)) {
      throw new FinError(
        'INTEGRITY_FAILURE',
        `Migration ${migration.version} did not record itself as applied`,
        {
          migrationVersion: migration.version,
          reason: 'migration_not_recorded',
        },
      )
    }
  }
}

function readAppliedMigrationVersions(database: DatabaseSync): Set<number> {
  if (!hasMigrationsTable(database)) {
    return new Set()
  }

  const rows = database.prepare('SELECT version FROM schema_migrations').all() as Array<{
    version: number
  }>
  return new Set(rows.map((row) => row.version))
}

function hasMigrationsTable(database: DatabaseSync): boolean {
  const migrationsTable = database
    .prepare(
      `SELECT count(*) AS count
       FROM sqlite_schema
       WHERE type = 'table' AND name = 'schema_migrations'`,
    )
    .get() as { count: number }

  return migrationsTable.count === 1
}

function readMigrations(): Array<{ version: number; sql: string }> {
  return readdirSync(migrationsDirectory)
    .map((fileName) => {
      const match = migrationFilePattern.exec(fileName)

      if (!match?.groups || Number(match.groups.version) === 0) {
        return undefined
      }

      return {
        version: Number(match.groups.version),
        sql: readFileSync(new URL(fileName, migrationsDirectory), 'utf8'),
      }
    })
    .filter((migration) => migration !== undefined)
    .sort((left, right) => left.version - right.version)
}

function readVaultState(database: DatabaseSync, path: string, databasePath: string): VaultState {
  const settings = database
    .prepare(
      `SELECT
         default_income_account_id,
         default_expense_account_id
       FROM vault_settings
       WHERE singleton_id = 1`,
    )
    .get() as
    | {
        default_income_account_id: number | null
        default_expense_account_id: number | null
      }
    | undefined

  if (!settings) {
    throw new FinError('INTEGRITY_FAILURE', `Vault settings are missing at ${path}`, {
      path,
      databasePath,
      reason: 'missing_vault_settings',
    })
  }

  return {
    path,
    databasePath,
    schemaVersion: readCurrentSchemaVersion(database),
    settings: {
      defaultIncomeAccountId: settings.default_income_account_id,
      defaultExpenseAccountId: settings.default_expense_account_id,
    },
    accountCount: readTableCount(database, 'accounts'),
    categoryCount: readTableCount(database, 'categories'),
  }
}

function readCurrentSchemaVersion(database: DatabaseSync): number {
  const row = database.prepare('SELECT max(version) AS version FROM schema_migrations').get() as {
    version: number | null
  }
  return row.version ?? 0
}

function readTableCount(database: DatabaseSync, tableName: 'accounts' | 'categories'): number {
  const row = database.prepare(`SELECT count(*) AS count FROM ${tableName}`).get() as {
    count: number
  }
  return row.count
}

function isFinVaultDatabase(databasePath: string): boolean {
  let database: DatabaseSync | undefined

  try {
    database = new DatabaseSync(databasePath)
    return hasMigrationsTable(database)
  } catch {
    return false
  } finally {
    database?.close()
  }
}

function createInvalidVaultError(path: string, databasePath: string): FinError {
  return new FinError('INTEGRITY_FAILURE', `Database at ${databasePath} is not a fin Vault`, {
    path,
    databasePath,
    reason: 'not_fin_vault',
  })
}
