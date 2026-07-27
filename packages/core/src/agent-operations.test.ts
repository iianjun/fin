import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createAccount,
  createCategory,
  initializeVault,
  recordAgentTransaction,
  setDefaultAccount,
} from './index.js'

describe('safe Agent-facing Transaction operation', () => {
  const temporaryDirectories: string[] = []

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { force: true, recursive: true })
    }
  })

  it('defaults the date and applicable Account and discloses every default', () => {
    const vaultPath = createVault()
    const bank = createAssetAccount(vaultPath, 'Bank')
    setDefaultAccount(vaultPath, 'expense', bank.id)

    const result = recordAgentTransaction(vaultPath, {
      kind: 'expense',
      amountMinor: 12_500,
    })

    expect(result.status).toBe('recorded')
    expect(result.reason).toBeNull()
    expect(result.receipt).toMatchObject({
      transaction: {
        kind: 'expense',
        occurredOn: currentLocalDate(),
        account: {
          id: bank.id,
          name: 'Bank',
          currency: 'KRW',
        },
        amountMinor: 12_500,
        memo: null,
      },
      previousBalanceMinor: 0,
      resultingBalanceMinor: -12_500,
      categoryAssignment: null,
      uncategorizedAmountMinor: 12_500,
      duplicateConfirmation: 'not_needed',
      applied: {
        kind: { value: 'expense', source: 'explicit' },
        account: { value: { id: bank.id }, source: 'default' },
        amountMinor: { value: 12_500, source: 'explicit' },
        occurredOn: { value: currentLocalDate(), source: 'default' },
        memo: { value: null, source: 'default_no_memo' },
        category: { value: null, source: 'omitted' },
        categoryAmountMinor: { value: null, source: 'omitted' },
      },
    })
    expect(readCount(vaultPath, 'transactions')).toBe(1)
  })

  it('returns kind, Account, and Category candidates without mutating on ambiguity', () => {
    const vaultPath = createVault()
    const dailyCash = createAssetAccount(vaultPath, 'Daily Cash')
    createAssetAccount(vaultPath, 'Travel Cash')
    const living = createCategory(vaultPath, { name: 'Living' }).category
    const travel = createCategory(vaultPath, { name: 'Travel' }).category
    const livingFood = createCategory(vaultPath, {
      name: 'Food',
      parentId: living.id,
    }).category
    const travelFood = createCategory(vaultPath, {
      name: 'Food',
      parentId: travel.id,
    }).category

    const kindAmbiguity = recordAgentTransaction(vaultPath, {
      amountMinor: 1_000,
      accountId: dailyCash.id,
    })
    expect(kindAmbiguity).toMatchObject({
      status: 'needs_clarification',
      reason: 'transaction_kind_ambiguity',
      candidates: {
        transactionKinds: [
          { kind: 'income', label: 'Income' },
          { kind: 'expense', label: 'Expense' },
        ],
      },
      receipt: null,
    })

    const accountAmbiguity = recordAgentTransaction(vaultPath, {
      kind: 'expense',
      accountName: 'Cash',
      amountMinor: 1_000,
    })
    expect(accountAmbiguity.status).toBe('needs_clarification')
    expect(accountAmbiguity.reason).toBe('account_ambiguity')
    expect(accountAmbiguity.candidates.accounts.map((account) => account.name)).toEqual([
      'Daily Cash',
      'Travel Cash',
    ])

    const categoryAmbiguity = recordAgentTransaction(vaultPath, {
      kind: 'expense',
      accountId: dailyCash.id,
      amountMinor: 1_000,
      categoryQuery: 'Food',
    })
    expect(categoryAmbiguity.status).toBe('needs_clarification')
    expect(categoryAmbiguity.reason).toBe('category_ambiguity')
    expect(categoryAmbiguity.candidates.categories.map((category) => category.path)).toEqual([
      livingFood.path,
      travelFood.path,
    ])
    expect(readCount(vaultPath, 'transactions')).toBe(0)
  })

  it('infers exactly one existing Category and marks its full applied path', () => {
    const vaultPath = createVault()
    const bank = createAssetAccount(vaultPath, 'Bank')
    const living = createCategory(vaultPath, { name: 'Living' }).category
    const food = createCategory(vaultPath, {
      name: 'Food',
      parentId: living.id,
    }).category
    const cafes = createCategory(vaultPath, {
      name: 'Cafes',
      parentId: food.id,
    }).category

    const result = recordAgentTransaction(vaultPath, {
      kind: 'expense',
      accountId: bank.id,
      amountMinor: 7_500,
      occurredOn: '2026-07-27',
      memo: 'coffee',
      categoryQuery: 'Cafes',
    })

    expect(result.status).toBe('recorded')
    expect(result.receipt).toMatchObject({
      transaction: {
        kind: 'expense',
        account: { id: bank.id },
        amountMinor: 7_500,
        occurredOn: '2026-07-27',
        memo: 'coffee',
      },
      categoryAssignment: {
        category: {
          id: cafes.id,
          path: 'Living > Food > Cafes',
        },
        amountMinor: 7_500,
        origin: 'inferred',
        currency: 'KRW',
      },
      uncategorizedAmountMinor: 0,
      applied: {
        account: { source: 'explicit' },
        occurredOn: { source: 'explicit' },
        memo: { source: 'explicit' },
        category: {
          value: {
            id: cafes.id,
            path: 'Living > Food > Cafes',
          },
          source: 'inferred',
        },
        categoryAmountMinor: {
          value: 7_500,
          source: 'default_full_amount',
        },
      },
    })
  })

  it('requires confirmation before creating an Agent-proposed Category', () => {
    const vaultPath = createVault()
    const bank = createAssetAccount(vaultPath, 'Bank')
    const intent = {
      kind: 'expense' as const,
      accountId: bank.id,
      amountMinor: 20_000,
      occurredOn: '2026-07-27',
      memo: 'dinner',
      categoryQuery: 'Dining',
      proposedCategory: {
        name: 'Dining',
      },
    }

    const proposed = recordAgentTransaction(vaultPath, intent)

    expect(proposed).toMatchObject({
      status: 'confirmation_required',
      reason: 'new_category_confirmation',
      proposedCategory: {
        name: 'Dining',
        parentId: null,
      },
      receipt: null,
    })
    expect(readCount(vaultPath, 'categories')).toBe(0)
    expect(readCount(vaultPath, 'transactions')).toBe(0)

    const confirmed = recordAgentTransaction(vaultPath, {
      ...intent,
      confirmNewCategory: true,
    })

    expect(confirmed.status).toBe('recorded')
    expect(confirmed.receipt).toMatchObject({
      createdCategory: {
        name: 'Dining',
        path: 'Dining',
      },
      categoryAssignment: {
        category: { path: 'Dining' },
        amountMinor: 20_000,
        origin: 'explicit',
      },
      applied: {
        category: {
          value: { path: 'Dining' },
          source: 'confirmed_new',
        },
        categoryAmountMinor: {
          value: 20_000,
          source: 'default_full_amount',
        },
      },
    })
    expect(readCount(vaultPath, 'categories')).toBe(1)
    expect(readCount(vaultPath, 'transactions')).toBe(1)
  })

  it('reports likely duplicate material values and records only after explicit confirmation', () => {
    const vaultPath = createVault()
    const bank = createAssetAccount(vaultPath, 'Bank')
    const intent = {
      kind: 'expense' as const,
      accountId: bank.id,
      amountMinor: 4_500,
      occurredOn: '2026-07-27',
      memo: 'coffee',
    }
    const first = recordAgentTransaction(vaultPath, intent)
    const duplicate = recordAgentTransaction(vaultPath, intent)

    expect(first.status).toBe('recorded')
    expect(duplicate).toMatchObject({
      status: 'confirmation_required',
      reason: 'duplicate_confirmation',
      duplicateMatches: [
        {
          transactionId: first.receipt?.transaction.id,
          kind: 'expense',
          occurredOn: '2026-07-27',
          account: {
            id: bank.id,
            name: 'Bank',
            currency: 'KRW',
          },
          amountMinor: 4_500,
          memo: 'coffee',
        },
      ],
      receipt: null,
    })
    expect(readCount(vaultPath, 'transactions')).toBe(1)

    const confirmed = recordAgentTransaction(vaultPath, {
      ...intent,
      confirmDuplicate: true,
    })

    expect(confirmed.status).toBe('recorded')
    expect(confirmed.receipt?.duplicateConfirmation).toBe('confirmed')
    expect(confirmed.receipt?.transaction.id).not.toBe(first.receipt?.transaction.id)
    expect(confirmed.duplicateMatches).toHaveLength(1)
    expect(readCount(vaultPath, 'transactions')).toBe(2)
  })

  function createVault(): string {
    const vaultPath = mkdtempSync(join(tmpdir(), 'fin-agent-operations-'))
    temporaryDirectories.push(vaultPath)
    initializeVault(vaultPath)
    return vaultPath
  }
})

function createAssetAccount(vaultPath: string, name: string) {
  return createAccount(vaultPath, {
    name,
    nature: 'asset',
    currency: 'KRW',
  }).account
}

function readCount(vaultPath: string, table: 'categories' | 'transactions'): number {
  const database = new DatabaseSync(join(vaultPath, 'fin.sqlite'))
  const row = database.prepare(`SELECT count(*) AS count FROM ${table}`).get() as {
    count: number
  }
  database.close()
  return row.count
}

function currentLocalDate(): string {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
