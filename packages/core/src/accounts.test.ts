import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { createAccount, initializeVault, listAccounts, setDefaultAccount } from './index.js'

type ChangeRecordRow = {
  entity_type: string
  entity_id: string
  action: string
  payload: string
}

describe('Account operations', () => {
  const temporaryDirectories: string[] = []

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { force: true, recursive: true })
    }
  })

  it('creates Asset and Liability Accounts and lists their current values', () => {
    const vaultPath = createVault()

    const cash = createAccount(vaultPath, {
      name: '  Cash  ',
      nature: 'asset',
      currency: 'krw',
    })
    const card = createAccount(vaultPath, {
      name: 'Card',
      nature: 'liability',
      currency: 'USD',
    })
    const database = openDatabase(vaultPath)
    database
      .prepare(
        `INSERT INTO transactions (kind, occurred_on, account_id, amount_minor)
         VALUES ('adjustment', '2026-07-27', ?, ?)`,
      )
      .run(cash.account.id, 25_000)
    database.close()

    expect(cash).toEqual({
      action: 'created',
      account: {
        id: 1,
        name: 'Cash',
        nature: 'asset',
        currency: 'KRW',
        archived: false,
        balanceMinor: 0,
      },
    })
    expect(card.account).toMatchObject({
      id: 2,
      name: 'Card',
      nature: 'liability',
      currency: 'USD',
      archived: false,
      balanceMinor: 0,
    })
    expect(listAccounts(vaultPath)).toEqual([
      {
        ...cash.account,
        balanceMinor: 25_000,
      },
      card.account,
    ])
  })

  it('rejects duplicate names with an actionable result and no Change Record', () => {
    const vaultPath = createVault()
    createAccount(vaultPath, { name: 'Cash', nature: 'asset', currency: 'KRW' })

    expect(() =>
      createAccount(vaultPath, { name: ' cash ', nature: 'liability', currency: 'USD' }),
    ).toThrow(/already used by Account 1.*Choose a unique Account name/)

    const database = openDatabase(vaultPath)
    const changeCount = database.prepare('SELECT count(*) AS count FROM change_records').get() as {
      count: number
    }
    database.close()

    expect(changeCount.count).toBe(1)
  })

  it('selects and clears separate Income and Expense defaults', () => {
    const vaultPath = createVault()
    const bank = createAccount(vaultPath, {
      name: 'Bank',
      nature: 'asset',
      currency: 'KRW',
    }).account
    const card = createAccount(vaultPath, {
      name: 'Card',
      nature: 'liability',
      currency: 'KRW',
    }).account

    const incomeResult = setDefaultAccount(vaultPath, 'income', bank.id)
    const expenseResult = setDefaultAccount(vaultPath, 'expense', card.id)
    const clearedResult = setDefaultAccount(vaultPath, 'income', null)

    expect(incomeResult).toEqual({
      action: 'updated',
      kind: 'income',
      selectedAccount: bank,
      settings: {
        defaultIncomeAccountId: bank.id,
        defaultExpenseAccountId: null,
      },
    })
    expect(expenseResult).toEqual({
      action: 'updated',
      kind: 'expense',
      selectedAccount: card,
      settings: {
        defaultIncomeAccountId: bank.id,
        defaultExpenseAccountId: card.id,
      },
    })
    expect(clearedResult).toEqual({
      action: 'updated',
      kind: 'income',
      selectedAccount: null,
      settings: {
        defaultIncomeAccountId: null,
        defaultExpenseAccountId: card.id,
      },
    })
  })

  it('rejects an archived default Account atomically', () => {
    const vaultPath = createVault()
    const account = createAccount(vaultPath, {
      name: 'Closed',
      nature: 'asset',
      currency: 'KRW',
    }).account
    const database = openDatabase(vaultPath)
    database
      .prepare(
        "UPDATE accounts SET archived_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
      )
      .run(account.id)
    database.close()

    expect(() => setDefaultAccount(vaultPath, 'expense', account.id)).toThrow(
      /Archived Account 1.*cannot be a default Account/,
    )

    const reopenedDatabase = openDatabase(vaultPath)
    const settings = reopenedDatabase
      .prepare(
        `SELECT default_income_account_id, default_expense_account_id
         FROM vault_settings`,
      )
      .get()
    const changeCount = reopenedDatabase
      .prepare('SELECT count(*) AS count FROM change_records')
      .get() as { count: number }
    reopenedDatabase.close()

    expect(settings).toEqual({
      default_income_account_id: null,
      default_expense_account_id: null,
    })
    expect(changeCount.count).toBe(1)
  })

  it('rolls back mutations when their Change Record cannot be written', () => {
    const vaultPath = createVault()
    const database = openDatabase(vaultPath)
    database.exec(`
      CREATE TRIGGER test_reject_account_change
      BEFORE INSERT ON change_records
      WHEN NEW.entity_type = 'account'
      BEGIN
        SELECT RAISE(ABORT, 'forced Account Change Record failure');
      END;
    `)
    database.close()

    expect(() =>
      createAccount(vaultPath, {
        name: 'Rolled Back',
        nature: 'asset',
        currency: 'KRW',
      }),
    ).toThrow(/forced Account Change Record failure/)
    expect(listAccounts(vaultPath)).toEqual([])

    const reopenedDatabase = openDatabase(vaultPath)
    reopenedDatabase.exec('DROP TRIGGER test_reject_account_change')
    reopenedDatabase.close()
    const account = createAccount(vaultPath, {
      name: 'Bank',
      nature: 'asset',
      currency: 'KRW',
    }).account
    const settingsDatabase = openDatabase(vaultPath)
    settingsDatabase.exec(`
      CREATE TRIGGER test_reject_settings_change
      BEFORE INSERT ON change_records
      WHEN NEW.entity_type = 'vault_settings'
      BEGIN
        SELECT RAISE(ABORT, 'forced settings Change Record failure');
      END;
    `)
    settingsDatabase.close()

    expect(() => setDefaultAccount(vaultPath, 'income', account.id)).toThrow(
      /forced settings Change Record failure/,
    )

    const finalDatabase = openDatabase(vaultPath)
    const settings = finalDatabase
      .prepare('SELECT default_income_account_id FROM vault_settings')
      .get() as { default_income_account_id: number | null }
    finalDatabase.close()

    expect(settings.default_income_account_id).toBeNull()
  })

  it('writes immutable structured Change Records with Account and setting mutations', () => {
    const vaultPath = createVault()
    const account = createAccount(vaultPath, {
      name: 'Bank',
      nature: 'asset',
      currency: 'KRW',
    }).account
    setDefaultAccount(vaultPath, 'income', account.id)

    const database = openDatabase(vaultPath)
    const changeRecords = database
      .prepare(
        `SELECT entity_type, entity_id, action, payload
         FROM change_records
         ORDER BY id`,
      )
      .all() as ChangeRecordRow[]

    expect(changeRecords).toHaveLength(2)
    expect(
      changeRecords.map(({ entity_type, entity_id, action }) => ({
        entityType: entity_type,
        entityId: entity_id,
        action,
      })),
    ).toEqual([
      { entityType: 'account', entityId: String(account.id), action: 'created' },
      { entityType: 'vault_settings', entityId: '1', action: 'updated' },
    ])
    const [accountChange, settingsChange] = changeRecords

    if (!accountChange || !settingsChange) {
      throw new Error('Expected Account and Vault settings Change Records')
    }

    expect(JSON.parse(accountChange.payload)).toEqual({ account })
    expect(JSON.parse(settingsChange.payload)).toEqual({
      kind: 'income',
      previousAccountId: null,
      accountId: account.id,
      settings: {
        defaultIncomeAccountId: account.id,
        defaultExpenseAccountId: null,
      },
    })
    expect(() =>
      database
        .prepare('UPDATE change_records SET payload = json(?) WHERE id = 1')
        .run('{"changed":true}'),
    ).toThrow(/change records are immutable/)
    database.close()
  })

  function createVault(): string {
    const parentPath = mkdtempSync(join(tmpdir(), 'fin-account-test-'))
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
