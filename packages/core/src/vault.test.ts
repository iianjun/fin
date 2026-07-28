import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { FinError, initializeVault, openVault } from './index.js'

describe('Vault lifecycle', () => {
  const temporaryDirectories: string[] = []

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { force: true, recursive: true })
    }
  })

  it('initializes an empty local Vault', () => {
    const vaultPath = createTemporaryVaultPath()

    const state = initializeVault(vaultPath)

    expect(existsSync(join(vaultPath, 'fin.sqlite'))).toBe(true)
    expect(state).toEqual({
      path: vaultPath,
      databasePath: join(vaultPath, 'fin.sqlite'),
      schemaVersion: 1,
      settings: {
        defaultIncomeAccountId: null,
        defaultExpenseAccountId: null,
      },
      accountCount: 0,
      categoryCount: 0,
    })
  })

  it('reopens a Vault without reapplying migrations or losing data', () => {
    const vaultPath = createTemporaryVaultPath()
    const initialized = initializeVault(vaultPath)
    const database = new DatabaseSync(initialized.databasePath)
    database
      .prepare("INSERT INTO accounts (name, nature, currency) VALUES ('Cash', 'asset', 'KRW')")
      .run()
    database.close()

    const reopened = openVault(vaultPath)

    expect(reopened.schemaVersion).toBe(1)
    expect(reopened.accountCount).toBe(1)
  })

  it('does not turn an unrelated SQLite database into a Vault when opening it', () => {
    const vaultPath = createTemporaryVaultPath()
    mkdirSync(vaultPath)
    const database = new DatabaseSync(join(vaultPath, 'fin.sqlite'))
    database.exec('CREATE TABLE unrelated_data (value TEXT)')
    database.close()

    expect(() => openVault(vaultPath)).toThrow(/not a fin Vault/)
  })

  it('reports a stable error code when a Vault is missing', () => {
    const vaultPath = createTemporaryVaultPath()

    expectFinError(() => openVault(vaultPath), 'VAULT_NOT_FOUND', { path: vaultPath })
  })

  it('reports a stable error code when a Vault already exists', () => {
    const vaultPath = createTemporaryVaultPath()
    initializeVault(vaultPath)

    expectFinError(() => initializeVault(vaultPath), 'VAULT_ALREADY_EXISTS', { path: vaultPath })
  })

  it('does not identify an unrelated database as an existing Vault during initialization', () => {
    const vaultPath = createTemporaryVaultPath()
    const databasePath = join(vaultPath, 'fin.sqlite')
    mkdirSync(vaultPath)
    const database = new DatabaseSync(databasePath)
    database.exec('CREATE TABLE unrelated_data (value TEXT)')
    database.close()

    expectFinError(() => initializeVault(vaultPath), 'INTEGRITY_FAILURE', {
      path: vaultPath,
      databasePath,
      reason: 'not_fin_vault',
    })
    expect(existsSync(databasePath)).toBe(true)
  })

  function createTemporaryVaultPath(): string {
    const parentPath = mkdtempSync(join(tmpdir(), 'fin-core-test-'))
    temporaryDirectories.push(parentPath)
    return join(parentPath, 'vault')
  }

  function expectFinError(
    operation: () => unknown,
    code: FinError['code'],
    details: Record<string, unknown>,
  ): void {
    try {
      operation()
      throw new Error('Expected operation to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(FinError)

      if (error instanceof FinError) {
        expect(error.code).toBe(code)
        expect(error.details).toEqual(details)
      }
    }
  }
})
