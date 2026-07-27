import type {
  Account,
  AccountMutationResult,
  Category,
  CategoryAssignment,
  CategoryMutationResult,
  IncomeExpenseTransaction,
  TransactionClassification,
  VaultState,
} from '@fin/core'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { afterEach, describe, expect, it } from 'vitest'
import { createFinServer, type FinOperations } from './server.js'

describe('fin MCP server', () => {
  let client: Client | undefined
  let server: McpServer | undefined

  afterEach(async () => {
    await client?.close()
    await server?.close()
  })

  it('initializes a Vault and returns a concrete summary', async () => {
    const initializedPaths: string[] = []
    const vaultState = createVaultState('/vaults/new')
    const connection = await connectTestClient({
      initializeVault: (path) => {
        initializedPaths.push(path)
        return vaultState
      },
      openVault: () => {
        throw new Error('openVault should not be called')
      },
    })
    client = connection.client
    server = connection.server

    const tools = await client.listTools()
    const result = await client.callTool({
      name: 'initialize_vault',
      arguments: { path: '/requested/new' },
    })

    expect(tools.tools.map((tool) => tool.name)).toContain('initialize_vault')
    expect(initializedPaths).toEqual(['/requested/new'])
    expect(result.content).toEqual([
      {
        type: 'text',
        text: 'Initialized Vault at /vaults/new with schema version 1, 0 Accounts, and 0 Categories.',
      },
    ])
    expect(result.structuredContent).toEqual({
      action: 'initialized',
      ...vaultState,
    })
  })

  it('opens an existing Vault and returns its current state', async () => {
    const openedPaths: string[] = []
    const vaultState = createVaultState('/vaults/existing', {
      accountCount: 2,
      categoryCount: 3,
    })
    const connection = await connectTestClient({
      initializeVault: () => {
        throw new Error('initializeVault should not be called')
      },
      openVault: (path) => {
        openedPaths.push(path)
        return vaultState
      },
    })
    client = connection.client
    server = connection.server

    const result = await client.callTool({
      name: 'open_vault',
      arguments: { path: '/requested/existing' },
    })

    expect(openedPaths).toEqual(['/requested/existing'])
    expect(result.content).toEqual([
      {
        type: 'text',
        text: 'Opened Vault at /vaults/existing with schema version 1, 2 Accounts, and 3 Categories.',
      },
    ])
    expect(result.structuredContent).toEqual({
      action: 'opened',
      ...vaultState,
    })
  })

  it('creates an Account and confirms every applied value', async () => {
    const creations: Array<{ path: string; name: string; nature: string; currency: string }> = []
    const account = createAccount()
    const connection = await connectTestClient({
      createAccount: (path, creation) => {
        creations.push({ path, ...creation })
        return { action: 'created', account }
      },
    })
    client = connection.client
    server = connection.server

    const result = await client.callTool({
      name: 'create_account',
      arguments: {
        path: '/vaults/main',
        name: 'Daily Cash',
        nature: 'asset',
        currency: 'KRW',
      },
    })

    expect(creations).toEqual([
      {
        path: '/vaults/main',
        name: 'Daily Cash',
        nature: 'asset',
        currency: 'KRW',
      },
    ])
    expect(result.content).toEqual([
      {
        type: 'text',
        text:
          'Created Asset Account "Daily Cash" (ID 7) in KRW with balance ' +
          '0 minor units; archived: no.',
      },
    ])
    expect(result.structuredContent).toEqual({ action: 'created', account })
  })

  it('lists Account nature, currency, archive state, and current balance', async () => {
    const account = createAccount({ archived: true, balanceMinor: 12_500 })
    const connection = await connectTestClient({
      listAccounts: () => [account],
    })
    client = connection.client
    server = connection.server

    const result = await client.callTool({
      name: 'list_accounts',
      arguments: { path: '/vaults/main' },
    })

    expect(result.content).toEqual([
      {
        type: 'text',
        text: '7: "Daily Cash" — Asset, KRW, balance 12500 minor units, ' + 'archived: yes',
      },
    ])
    expect(result.structuredContent).toEqual({ accounts: [account] })
  })

  it('selects or clears a default Account and confirms the resulting settings', async () => {
    const account = createAccount()
    const requests: Array<{ kind: string; accountId: number | null }> = []
    const connection = await connectTestClient({
      setDefaultAccount: (_path, kind, accountId) => {
        requests.push({ kind, accountId })

        return {
          action: 'updated',
          kind,
          selectedAccount: accountId === null ? null : account,
          settings: {
            defaultIncomeAccountId: accountId,
            defaultExpenseAccountId: null,
          },
        }
      },
    })
    client = connection.client
    server = connection.server

    const selected = await client.callTool({
      name: 'set_default_account',
      arguments: { path: '/vaults/main', kind: 'income', accountId: account.id },
    })
    const cleared = await client.callTool({
      name: 'set_default_account',
      arguments: { path: '/vaults/main', kind: 'income', accountId: null },
    })

    expect(requests).toEqual([
      { kind: 'income', accountId: account.id },
      { kind: 'income', accountId: null },
    ])
    expect(selected.content).toEqual([
      {
        type: 'text',
        text:
          'Set default income Account to "Daily Cash" ' +
          '(ID 7, Asset, KRW, archived: no). Defaults now: Income 7, Expense none.',
      },
    ])
    expect(selected.structuredContent).toEqual({
      action: 'updated',
      kind: 'income',
      selectedAccount: account,
      settings: {
        defaultIncomeAccountId: account.id,
        defaultExpenseAccountId: null,
      },
    })
    expect(cleared.content).toEqual([
      {
        type: 'text',
        text: 'Cleared the default income Account. Defaults now: Income none, Expense none.',
      },
    ])
  })

  it('updates an Account and confirms its previous and applied values', async () => {
    const previousAccount = createAccount()
    const account = createAccount({ name: 'Everyday', nature: 'liability', currency: 'USD' })
    const updates: Array<{
      accountId: number
      name: string | undefined
      nature: string | undefined
      currency: string | undefined
    }> = []
    const mutation = createAccountMutation('details_updated', previousAccount, account)
    const connection = await connectTestClient({
      updateAccount: (_path, accountId, update) => {
        updates.push({
          accountId,
          name: update.name,
          nature: update.nature,
          currency: update.currency,
        })
        return mutation
      },
    })
    client = connection.client
    server = connection.server

    const result = await client.callTool({
      name: 'update_account',
      arguments: {
        path: '/vaults/main',
        accountId: account.id,
        name: account.name,
        nature: account.nature,
        currency: account.currency,
      },
    })

    expect(updates).toEqual([
      {
        accountId: account.id,
        name: 'Everyday',
        nature: 'liability',
        currency: 'USD',
      },
    ])
    expect(result.content).toEqual([
      {
        type: 'text',
        text:
          'Updated Account 7 from Asset Account "Daily Cash" ' +
          '(KRW, balance 0 minor units, archived: no) to Liability Account "Everyday" ' +
          '(USD, balance 0 minor units, archived: no).',
      },
    ])
    expect(result.structuredContent).toEqual(mutation)
  })

  it('archives and reactivates an Account with detailed receipts', async () => {
    const activeAccount = createAccount()
    const archivedAccount = createAccount({ archived: true })
    const archived = createAccountMutation('archived', activeAccount, archivedAccount)
    const reactivated = createAccountMutation('reactivated', archivedAccount, activeAccount)
    const connection = await connectTestClient({
      archiveAccount: () => archived,
      reactivateAccount: () => reactivated,
    })
    client = connection.client
    server = connection.server

    const archiveResult = await client.callTool({
      name: 'archive_account',
      arguments: { path: '/vaults/main', accountId: activeAccount.id },
    })
    const reactivateResult = await client.callTool({
      name: 'reactivate_account',
      arguments: { path: '/vaults/main', accountId: activeAccount.id },
    })

    expect(archiveResult.content).toEqual([
      {
        type: 'text',
        text:
          'Archived Asset Account "Daily Cash" ' + '(KRW, balance 0 minor units, archived: yes).',
      },
    ])
    expect(archiveResult.structuredContent).toEqual(archived)
    expect(reactivateResult.content).toEqual([
      {
        type: 'text',
        text:
          'Reactivated Asset Account "Daily Cash" ' + '(KRW, balance 0 minor units, archived: no).',
      },
    ])
    expect(reactivateResult.structuredContent).toEqual(reactivated)
  })

  it('creates and lists Categories with their complete paths', async () => {
    const category = createCategory()
    const creations: Array<{ name: string; parentId: number | null | undefined }> = []
    const connection = await connectTestClient({
      createCategory: (_path, creation) => {
        creations.push({ name: creation.name, parentId: creation.parentId })
        return { action: 'created', category }
      },
      listCategories: () => [category],
    })
    client = connection.client
    server = connection.server

    const created = await client.callTool({
      name: 'create_category',
      arguments: {
        path: '/vaults/main',
        name: 'Dining',
        parentId: 2,
      },
    })
    const listed = await client.callTool({
      name: 'list_categories',
      arguments: { path: '/vaults/main' },
    })

    expect(creations).toEqual([{ name: 'Dining', parentId: 2 }])
    expect(created.content).toEqual([
      {
        type: 'text',
        text: 'Created Category "Living > Food > Dining" (depth 3, archived: no).',
      },
    ])
    expect(created.structuredContent).toEqual({ action: 'created', category })
    expect(listed.content).toEqual([
      {
        type: 'text',
        text: '9: Category "Living > Food > Dining" (depth 3, archived: no)',
      },
    ])
    expect(listed.structuredContent).toEqual({ categories: [category] })
  })

  it('renames or moves a Category and confirms its old and complete new path', async () => {
    const previousCategory = createCategory()
    const category = createCategory({
      parentId: 5,
      name: 'Restaurants',
      path: 'Travel > Restaurants',
      depth: 2,
    })
    const mutation = createCategoryMutation('details_updated', previousCategory, category)
    const connection = await connectTestClient({
      updateCategory: () => mutation,
    })
    client = connection.client
    server = connection.server

    const result = await client.callTool({
      name: 'update_category',
      arguments: {
        path: '/vaults/main',
        categoryId: category.id,
        name: category.name,
        parentId: category.parentId,
      },
    })

    expect(result.content).toEqual([
      {
        type: 'text',
        text:
          'Updated Category 9 from "Living > Food > Dining" to ' +
          'Category "Travel > Restaurants" (depth 2, archived: no).',
      },
    ])
    expect(result.structuredContent).toEqual(mutation)
  })

  it('archives and reactivates a Category with its complete path', async () => {
    const activeCategory = createCategory()
    const archivedCategory = createCategory({ archived: true })
    const archived = createCategoryMutation('archived', activeCategory, archivedCategory)
    const reactivated = createCategoryMutation('reactivated', archivedCategory, activeCategory)
    const connection = await connectTestClient({
      archiveCategory: () => archived,
      reactivateCategory: () => reactivated,
    })
    client = connection.client
    server = connection.server

    const archiveResult = await client.callTool({
      name: 'archive_category',
      arguments: { path: '/vaults/main', categoryId: activeCategory.id },
    })
    const reactivateResult = await client.callTool({
      name: 'reactivate_category',
      arguments: { path: '/vaults/main', categoryId: activeCategory.id },
    })

    expect(archiveResult.content).toEqual([
      {
        type: 'text',
        text: 'Archived Category "Living > Food > Dining" (depth 3, archived: yes).',
      },
    ])
    expect(archiveResult.structuredContent).toEqual(archived)
    expect(reactivateResult.content).toEqual([
      {
        type: 'text',
        text: 'Reactivated Category "Living > Food > Dining" (depth 3, archived: no).',
      },
    ])
    expect(reactivateResult.structuredContent).toEqual(reactivated)
  })

  it('records Income or Expense and confirms every applied material value', async () => {
    const transaction = createIncomeExpenseTransaction()
    const creations: Array<{
      kind: string
      accountId: number
      amountMinor: number
      occurredOn: string
      memo: string | null | undefined
    }> = []
    const connection = await connectTestClient({
      recordIncomeExpense: (_path, creation) => {
        creations.push({
          kind: creation.kind,
          accountId: creation.accountId,
          amountMinor: creation.amountMinor,
          occurredOn: creation.occurredOn,
          memo: creation.memo,
        })
        return {
          action: 'created',
          transaction,
          previousBalanceMinor: 250_000,
          resultingBalanceMinor: 220_000,
        }
      },
    })
    client = connection.client
    server = connection.server

    const result = await client.callTool({
      name: 'record_income_expense',
      arguments: {
        path: '/vaults/main',
        kind: 'expense',
        accountId: 4,
        amountMinor: 30_000,
        occurredOn: '2026-07-27',
        memo: 'groceries',
      },
    })

    expect(creations).toEqual([
      {
        kind: 'expense',
        accountId: 4,
        amountMinor: 30_000,
        occurredOn: '2026-07-27',
        memo: 'groceries',
      },
    ])
    expect(result.content).toEqual([
      {
        type: 'text',
        text:
          'Recorded Asset Account "Bank" (ID 4, KRW) — Expense Transaction 12, ' +
          '30000 minor units on 2026-07-27, memo "groceries". ' +
          'Account balance changed from 250000 to 220000 minor units.',
      },
    ])
    expect(result.structuredContent).toEqual({
      action: 'created',
      transaction,
      previousBalanceMinor: 250_000,
      resultingBalanceMinor: 220_000,
    })
  })

  it('lists and inspects Income and Expense Transactions with material values', async () => {
    const transaction = createIncomeExpenseTransaction({ memo: null })
    const connection = await connectTestClient({
      listIncomeExpenseTransactions: () => [transaction],
      getIncomeExpenseTransaction: () => transaction,
    })
    client = connection.client
    server = connection.server

    const listed = await client.callTool({
      name: 'list_income_expense_transactions',
      arguments: { path: '/vaults/main' },
    })
    const inspected = await client.callTool({
      name: 'get_income_expense_transaction',
      arguments: { path: '/vaults/main', transactionId: transaction.id },
    })
    const text =
      'Asset Account "Bank" (ID 4, KRW) — Expense Transaction 12, ' +
      '30000 minor units on 2026-07-27, no memo'

    expect(listed.content).toEqual([{ type: 'text', text }])
    expect(listed.structuredContent).toEqual({ transactions: [transaction] })
    expect(inspected.content).toEqual([{ type: 'text', text }])
    expect(inspected.structuredContent).toEqual({ transaction })
  })

  it('sets Category Assignments and confirms inferred full paths and remainder', async () => {
    const classification = createTransactionClassification()
    const requests: Array<{
      transactionId: number
      assignments: Array<{ categoryId: number; amountMinor: number; origin: string }>
    }> = []
    const result = {
      action: 'updated' as const,
      ...classification,
      previousAssignments: [],
    }
    const connection = await connectTestClient({
      setCategoryAssignments: (_path, transactionId, assignments) => {
        requests.push({ transactionId, assignments })
        return result
      },
    })
    client = connection.client
    server = connection.server

    const response = await client.callTool({
      name: 'set_category_assignments',
      arguments: {
        path: '/vaults/main',
        transactionId: classification.transaction.id,
        assignments: [
          {
            categoryId: 8,
            amountMinor: 20_000,
            origin: 'inferred',
          },
        ],
      },
    })

    expect(requests).toEqual([
      {
        transactionId: 12,
        assignments: [{ categoryId: 8, amountMinor: 20_000, origin: 'inferred' }],
      },
    ])
    expect(response.content).toEqual([
      {
        type: 'text',
        text:
          'Expense Transaction 12, 30000 KRW: inferred Category "Living > Food": ' +
          '20000 KRW. Uncategorized remainder: 10000 KRW.',
      },
    ])
    expect(response.structuredContent).toEqual(result)
  })

  it('inspects a Transaction with no Category Assignments', async () => {
    const classification = createTransactionClassification({
      assignments: [],
      uncategorizedAmountMinor: 30_000,
    })
    const connection = await connectTestClient({
      getTransactionClassification: () => classification,
    })
    client = connection.client
    server = connection.server

    const response = await client.callTool({
      name: 'get_transaction_classification',
      arguments: { path: '/vaults/main', transactionId: 12 },
    })

    expect(response.content).toEqual([
      {
        type: 'text',
        text:
          'Expense Transaction 12, 30000 KRW: no Category Assignments. ' +
          'Uncategorized remainder: 30000 KRW.',
      },
    ])
    expect(response.structuredContent).toEqual(classification)
  })

  function createAccount(overrides: Partial<Account> = {}): Account {
    return {
      id: 7,
      name: 'Daily Cash',
      nature: 'asset',
      currency: 'KRW',
      archived: false,
      balanceMinor: 0,
      ...overrides,
    }
  }

  function createAccountMutation(
    mutation: AccountMutationResult['mutation'],
    previousAccount: Account,
    account: Account,
  ): AccountMutationResult {
    return {
      action: 'updated',
      mutation,
      previousAccount,
      account,
    }
  }

  function createCategory(overrides: Partial<Category> = {}): Category {
    return {
      id: 9,
      parentId: 2,
      name: 'Dining',
      depth: 3,
      path: 'Living > Food > Dining',
      archived: false,
      ...overrides,
    }
  }

  function createCategoryMutation(
    mutation: CategoryMutationResult['mutation'],
    previousCategory: Category,
    category: Category,
  ): CategoryMutationResult {
    return {
      action: 'updated',
      mutation,
      previousCategory,
      category,
    }
  }

  function createIncomeExpenseTransaction(
    overrides: Partial<IncomeExpenseTransaction> = {},
  ): IncomeExpenseTransaction {
    return {
      id: 12,
      kind: 'expense',
      occurredOn: '2026-07-27',
      account: {
        id: 4,
        name: 'Bank',
        nature: 'asset',
        currency: 'KRW',
        archived: false,
      },
      amountMinor: 30_000,
      memo: 'groceries',
      ...overrides,
    }
  }

  function createCategoryAssignment(
    overrides: Partial<CategoryAssignment> = {},
  ): CategoryAssignment {
    return {
      id: 21,
      category: {
        id: 8,
        path: 'Living > Food',
      },
      amountMinor: 20_000,
      origin: 'inferred',
      currency: 'KRW',
      ...overrides,
    }
  }

  function createTransactionClassification(
    overrides: Partial<TransactionClassification> = {},
  ): TransactionClassification {
    return {
      transaction: createIncomeExpenseTransaction(),
      assignments: [createCategoryAssignment()],
      uncategorizedAmountMinor: 10_000,
      ...overrides,
    }
  }

  function createVaultState(
    path: string,
    counts: { accountCount: number; categoryCount: number } = {
      accountCount: 0,
      categoryCount: 0,
    },
  ): VaultState {
    return {
      path,
      databasePath: `${path}/fin.sqlite`,
      schemaVersion: 1,
      settings: {
        defaultIncomeAccountId: null,
        defaultExpenseAccountId: null,
      },
      ...counts,
    }
  }

  async function connectTestClient(
    operations: Partial<FinOperations>,
  ): Promise<{ client: Client; server: McpServer }> {
    const server = createFinServer(operations)
    const client = new Client({ name: 'fin-test-client', version: '0.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])

    return { client, server }
  }
})
