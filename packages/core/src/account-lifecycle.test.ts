import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  archiveAccount,
  createAccount,
  initializeVault,
  listAccounts,
  reactivateAccount,
  setDefaultAccount,
  updateAccount,
} from './index.js'

describe('Account lifecycle operations', () => {
  const temporaryDirectories: string[] = []

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { force: true, recursive: true })
    }
  })

  it('renames an Account without changing its identity or historical references', () => {
    const vaultPath = createVault()
    const account = createAccount(vaultPath, {
      name: 'Everyday',
      nature: 'asset',
      currency: 'KRW',
    }).account
    const database = openDatabase(vaultPath)
    const transactionId = insertAdjustment(database, account.id, 1_000)
    database.close()

    const result = updateAccount(vaultPath, account.id, { name: 'Daily Bank' })
    const reopenedDatabase = openDatabase(vaultPath)
    const transaction = reopenedDatabase
      .prepare('SELECT account_id FROM transactions WHERE id = ?')
      .get(transactionId) as { account_id: number }
    reopenedDatabase.close()

    expect(result).toEqual({
      action: 'updated',
      mutation: 'details_updated',
      previousAccount: {
        ...account,
        balanceMinor: 1_000,
      },
      account: {
        ...account,
        name: 'Daily Bank',
        balanceMinor: 1_000,
      },
    })
    expect(transaction.account_id).toBe(account.id)
  })

  it('keeps names unique across active and archived Accounts', () => {
    const vaultPath = createVault()
    const active = createAccount(vaultPath, {
      name: 'Active',
      nature: 'asset',
      currency: 'KRW',
    }).account
    const archived = createAccount(vaultPath, {
      name: 'Retired',
      nature: 'asset',
      currency: 'KRW',
    }).account
    archiveAccount(vaultPath, archived.id)

    expect(() => updateAccount(vaultPath, active.id, { name: ' retired ' })).toThrow(
      /already used by Account 2.*Choose a unique Account name/,
    )
    expect(
      listAccounts(vaultPath).map(({ id, name, archived }) => ({ id, name, archived })),
    ).toEqual([
      { id: active.id, name: 'Active', archived: false },
      { id: archived.id, name: 'Retired', archived: true },
    ])
  })

  it('changes nature and currency only before the first Transaction', () => {
    const vaultPath = createVault()
    const account = createAccount(vaultPath, {
      name: 'Flexible',
      nature: 'asset',
      currency: 'KRW',
    }).account

    const changed = updateAccount(vaultPath, account.id, {
      nature: 'liability',
      currency: 'usd',
    })
    const database = openDatabase(vaultPath)
    insertAdjustment(database, account.id, 2_000)
    database.close()
    const renamed = updateAccount(vaultPath, account.id, { name: 'Still Flexible' })

    expect(changed.account).toEqual({
      ...account,
      nature: 'liability',
      currency: 'USD',
    })
    expect(renamed.account.name).toBe('Still Flexible')
    expect(() => updateAccount(vaultPath, account.id, { currency: 'EUR' })).toThrow(
      /nature and currency cannot change after its first Transaction/,
    )
    expect(() => updateAccount(vaultPath, account.id, { nature: 'asset' })).toThrow(
      /nature and currency cannot change after its first Transaction/,
    )
  })

  it('rejects archiving while the Account balance is nonzero', () => {
    const vaultPath = createVault()
    const account = createAccount(vaultPath, {
      name: 'Funded',
      nature: 'asset',
      currency: 'KRW',
    }).account
    const database = openDatabase(vaultPath)
    insertAdjustment(database, account.id, -12_000)
    database.close()

    expect(() => archiveAccount(vaultPath, account.id)).toThrow(
      /cannot be archived with a nonzero balance of -12000 KRW.*Bring the Account balance to zero/,
    )
    expect(listAccounts(vaultPath)[0]?.archived).toBe(false)
  })

  it('rejects archiving while the Account is an Income or Expense default', () => {
    const vaultPath = createVault()
    const account = createAccount(vaultPath, {
      name: 'Default',
      nature: 'asset',
      currency: 'KRW',
    }).account
    setDefaultAccount(vaultPath, 'income', account.id)
    setDefaultAccount(vaultPath, 'expense', account.id)

    expect(() => archiveAccount(vaultPath, account.id)).toThrow(
      /default Income and Expense Account.*Clear the default before archiving/,
    )
    expect(listAccounts(vaultPath)[0]?.archived).toBe(false)
  })

  it('keeps an archived Account visible and historical while blocking new Transactions', () => {
    const vaultPath = createVault()
    const account = createAccount(vaultPath, {
      name: 'Closed',
      nature: 'asset',
      currency: 'KRW',
    }).account
    const database = openDatabase(vaultPath)
    insertAdjustment(database, account.id, 500)
    insertAdjustment(database, account.id, -500)
    database.close()

    const archived = archiveAccount(vaultPath, account.id)
    const archivedDatabase = openDatabase(vaultPath)
    const historicalCount = archivedDatabase
      .prepare('SELECT count(*) AS count FROM transactions WHERE account_id = ?')
      .get(account.id) as { count: number }

    expect(archived.account).toEqual({ ...account, archived: true })
    expect(listAccounts(vaultPath)).toEqual([{ ...account, archived: true }])
    expect(historicalCount.count).toBe(2)
    expect(() => insertAdjustment(archivedDatabase, account.id, 100)).toThrow(
      /archived account cannot receive new transactions/,
    )
    archivedDatabase.close()

    const reactivated = reactivateAccount(vaultPath, account.id)
    const activeDatabase = openDatabase(vaultPath)

    expect(reactivated).toEqual({
      action: 'updated',
      mutation: 'reactivated',
      previousAccount: { ...account, archived: true },
      account,
    })
    expect(() => insertAdjustment(activeDatabase, account.id, 100)).not.toThrow()
    activeDatabase.close()
  })

  it('writes detailed lifecycle Change Records atomically', () => {
    const vaultPath = createVault()
    const account = createAccount(vaultPath, {
      name: 'Audited',
      nature: 'asset',
      currency: 'KRW',
    }).account
    const database = openDatabase(vaultPath)
    database.exec(`
      CREATE TRIGGER test_reject_lifecycle_change
      BEFORE INSERT ON change_records
      WHEN NEW.entity_type = 'account' AND NEW.action = 'updated'
      BEGIN
        SELECT RAISE(ABORT, 'forced lifecycle Change Record failure');
      END;
    `)
    database.close()

    expect(() => updateAccount(vaultPath, account.id, { name: 'Rolled Back' })).toThrow(
      /forced lifecycle Change Record failure/,
    )
    expect(listAccounts(vaultPath)).toEqual([account])

    const reopenedDatabase = openDatabase(vaultPath)
    reopenedDatabase.exec('DROP TRIGGER test_reject_lifecycle_change')
    reopenedDatabase.close()

    const updated = updateAccount(vaultPath, account.id, { name: 'Tracked' })
    const archived = archiveAccount(vaultPath, account.id)
    const reactivated = reactivateAccount(vaultPath, account.id)
    const finalDatabase = openDatabase(vaultPath)
    const rows = finalDatabase
      .prepare(
        `SELECT payload
         FROM change_records
         WHERE entity_type = 'account' AND action = 'updated'
         ORDER BY id`,
      )
      .all() as Array<{ payload: string }>
    finalDatabase.close()

    expect(rows.map(({ payload }) => JSON.parse(payload))).toEqual([updated, archived, reactivated])
  })

  function createVault(): string {
    const parentPath = mkdtempSync(join(tmpdir(), 'fin-account-lifecycle-test-'))
    temporaryDirectories.push(parentPath)
    const vaultPath = join(parentPath, 'vault')
    initializeVault(vaultPath)
    return vaultPath
  }

  function openDatabase(vaultPath: string): DatabaseSync {
    const database = new DatabaseSync(join(vaultPath, 'fin.sqlite'))
    database.exec('PRAGMA foreign_keys = ON')
    return database
  }
})

function insertAdjustment(database: DatabaseSync, accountId: number, amountMinor: number): number {
  return Number(
    database
      .prepare(
        `INSERT INTO transactions (kind, occurred_on, account_id, amount_minor)
         VALUES ('adjustment', '2026-07-27', ?, ?)`,
      )
      .run(accountId, amountMinor).lastInsertRowid,
  )
}
