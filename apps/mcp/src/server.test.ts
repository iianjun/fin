import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  Account,
  AccountMutationResult,
  AdjustmentTransaction,
  AgentTransactionResult,
  BalanceQueryResult,
  Category,
  CategoryAssignment,
  CategoryMutationResult,
  DeleteTransactionResult,
  EditTransactionResult,
  IncomeExpenseTransaction,
  IncomeExpenseTransactionState,
  QueryIncomeExpenseTransaction,
  RecordRelatedExpenseResult,
  RecreateTransactionResult,
  SpendingQueryResult,
  TransactionChangeRecord,
  TransactionClassification,
  TransactionQueryResult,
  TransactionRelationInspection,
  TransactionSnapshot,
  TransferTransaction,
  VaultState,
} from '@fin/core'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { afterEach, describe, expect, it } from 'vitest'
import { createFinServer, type FinOperations } from './server.js'
import type { VaultLocationStore } from './vault-location.js'

describe('fin MCP server', () => {
  let client: Client | undefined
  let server: McpServer | undefined
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    await client?.close()
    await server?.close()

    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { force: true, recursive: true })
    }
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
    expect(connection.selectedVaultPath()).toBe('/vaults/new')
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
    expect(connection.selectedVaultPath()).toBe('/vaults/existing')
  })

  it('asks the Agent to select a Vault before using financial tools', async () => {
    const connection = await connectTestClient({}, null)
    client = connection.client
    server = connection.server

    const result = await client.callTool({
      name: 'list_accounts',
      arguments: {},
    })

    expect(result.isError).toBe(true)
    expect(result.content).toEqual([
      {
        type: 'text',
        text:
          'No fin Vault is selected. Ask the user for a local folder, then call open_vault ' +
          'for an existing Vault or initialize_vault for a new Vault before retrying this tool.',
      },
    ])
    expect(result._meta).toEqual({
      'fin/error': {
        code: 'VAULT_NOT_CONFIGURED',
        retryable: true,
      },
    })
  })

  it('only asks lifecycle tools for a Vault path', async () => {
    const connection = await connectTestClient({})
    client = connection.client
    server = connection.server

    const { tools } = await client.listTools()

    for (const tool of tools) {
      const properties = (tool.inputSchema.properties ?? {}) as Record<string, unknown>

      if (tool.name === 'initialize_vault' || tool.name === 'open_vault') {
        expect(properties).toHaveProperty('path')
      } else {
        expect(properties).not.toHaveProperty('path')
      }
    }
  })

  it('tells the Agent to initialize a missing Vault with the same path', async () => {
    const vaultPath = createTemporaryVaultPath()
    const connection = await connectTestClient({})
    client = connection.client
    server = connection.server

    await client.listTools()
    const result = await client.callTool({
      name: 'open_vault',
      arguments: { path: vaultPath },
    })

    expect(result.isError).toBe(true)
    expect(result.content).toEqual([
      {
        type: 'text',
        text:
          `No fin Vault exists at ${vaultPath}. ` +
          'Call initialize_vault with the same path before retrying open_vault.',
      },
    ])
    expect(result._meta).toEqual({
      'fin/error': {
        code: 'VAULT_NOT_FOUND',
        retryable: true,
        recovery: {
          tool: 'initialize_vault',
          arguments: { path: vaultPath },
        },
        retry: {
          tool: 'open_vault',
          arguments: { path: vaultPath },
        },
      },
    })
    expect(connection.selectedVaultPath()).toBe('/vaults/main')
  })

  it('tells the Agent to initialize a missing Vault before retrying a financial tool', async () => {
    const vaultPath = createTemporaryVaultPath()
    const connection = await connectTestClient({}, vaultPath)
    client = connection.client
    server = connection.server

    const result = await client.callTool({
      name: 'list_accounts',
      arguments: {},
    })

    expect(result.isError).toBe(true)
    expect(result.content).toEqual([
      {
        type: 'text',
        text:
          `No fin Vault exists at ${vaultPath}. ` +
          'Call initialize_vault with the same path before retrying list_accounts.',
      },
    ])
    expect(result._meta).toEqual({
      'fin/error': {
        code: 'VAULT_NOT_FOUND',
        retryable: true,
        recovery: {
          tool: 'initialize_vault',
          arguments: { path: vaultPath },
        },
        retry: {
          tool: 'list_accounts',
          arguments: {},
        },
      },
    })
  })

  it('tells the Agent to open a Vault that is already initialized', async () => {
    const vaultPath = createTemporaryVaultPath()
    const connection = await connectTestClient({})
    client = connection.client
    server = connection.server

    await client.callTool({
      name: 'initialize_vault',
      arguments: { path: vaultPath },
    })
    const result = await client.callTool({
      name: 'initialize_vault',
      arguments: { path: vaultPath },
    })

    expect(result.isError).toBe(true)
    expect(result.content).toEqual([
      {
        type: 'text',
        text:
          `A fin Vault already exists at ${vaultPath}. ` +
          'Call open_vault with the same path instead of initializing it again.',
      },
    ])
    expect(result._meta).toEqual({
      'fin/error': {
        code: 'VAULT_ALREADY_EXISTS',
        retryable: true,
        recovery: {
          tool: 'open_vault',
          arguments: { path: vaultPath },
        },
      },
    })
  })

  it('advertises the safe Vault workflow during server initialization', async () => {
    const connection = await connectTestClient({})
    client = connection.client
    server = connection.server

    const instructions = client.getInstructions()

    expect(instructions).toContain('remembers one selected Vault across server restarts')
    expect(instructions).toContain('ask the user for a local folder')
    expect(instructions).toContain('open_vault for an existing Vault')
    expect(instructions).toContain('initialize_vault for a new Vault')
    expect(instructions).toContain('Never initialize over an existing non-fin database')
    expect(instructions).toContain('Do not automatically retry integrity or system failures')
  })

  it('prevents initialization from overwriting a non-fin database', async () => {
    const vaultPath = createTemporaryVaultPath()
    const databasePath = join(vaultPath, 'fin.sqlite')
    mkdirSync(vaultPath)
    const database = new DatabaseSync(databasePath)
    database.exec('CREATE TABLE unrelated_data (value TEXT)')
    database.close()
    const connection = await connectTestClient({})
    client = connection.client
    server = connection.server

    await client.listTools()
    const result = await client.callTool({
      name: 'initialize_vault',
      arguments: { path: vaultPath },
    })

    expect(result.isError).toBe(true)
    expect(result.content).toEqual([
      {
        type: 'text',
        text:
          `The database at ${databasePath} is not a valid fin Vault. ` +
          'Do not call initialize_vault, overwrite the database, or retry this tool. ' +
          'Ask the user to inspect the existing database or choose a different path.',
      },
    ])
    expect(result._meta).toEqual({
      'fin/error': {
        code: 'INTEGRITY_FAILURE',
        retryable: false,
      },
    })
  })

  it('sanitizes an unknown filesystem failure and prevents unsafe recovery', async () => {
    const vaultPath = createTemporaryVaultPath()
    writeFileSync(vaultPath, 'not a directory')
    const connection = await connectTestClient({})
    client = connection.client
    server = connection.server

    await client.listTools()
    const result = await client.callTool({
      name: 'initialize_vault',
      arguments: { path: vaultPath },
    })

    expect(result.isError).toBe(true)
    expect(result.content).toEqual([
      {
        type: 'text',
        text:
          `fin could not safely access the Vault path ${vaultPath}. ` +
          'Verify the path and its permissions with the user. Do not retry or call ' +
          'initialize_vault until the location has been verified.',
      },
    ])
    expect(result.content).not.toContainEqual(
      expect.objectContaining({ text: expect.stringContaining('EEXIST') }),
    )
    expect(result._meta).toEqual({
      'fin/error': {
        code: 'SYSTEM_FAILURE',
        retryable: false,
      },
    })
  })

  it('prevents retries when an initialized Vault has invalid internal state', async () => {
    const vaultPath = createTemporaryVaultPath()
    const connection = await connectTestClient({})
    client = connection.client
    server = connection.server

    const initialized = await client.callTool({
      name: 'initialize_vault',
      arguments: { path: vaultPath },
    })
    const databasePath = (initialized.structuredContent as { databasePath: string }).databasePath
    const database = new DatabaseSync(databasePath)
    database.exec('DROP TRIGGER vault_settings_prevent_delete')
    database.exec('DELETE FROM vault_settings')
    database.close()

    const result = await client.callTool({
      name: 'open_vault',
      arguments: { path: vaultPath },
    })

    expect(result.isError).toBe(true)
    expect(result.content).toEqual([
      {
        type: 'text',
        text:
          `The fin Vault at ${vaultPath} has an invalid internal state. ` +
          'Do not retry or call initialize_vault. Ask the user to inspect the Vault and ' +
          'report the problem.',
      },
    ])
    expect(result._meta).toEqual({
      'fin/error': {
        code: 'INTEGRITY_FAILURE',
        retryable: false,
      },
    })
  })

  it('tells the Agent how to discover a valid Account before retrying', async () => {
    const vaultPath = createTemporaryVaultPath()
    const connection = await connectTestClient({})
    client = connection.client
    server = connection.server

    await client.callTool({
      name: 'initialize_vault',
      arguments: { path: vaultPath },
    })
    const result = await client.callTool({
      name: 'update_account',
      arguments: {
        accountId: 999,
        name: 'Missing',
      },
    })

    expect(result.isError).toBe(true)
    expect(result.content).toEqual([
      {
        type: 'text',
        text:
          'Account 999 does not exist. Call list_accounts to inspect valid Account IDs in the ' +
          'selected Vault before retrying update_account.',
      },
    ])
    expect(result._meta).toEqual({
      'fin/error': {
        code: 'ENTITY_NOT_FOUND',
        retryable: true,
        recovery: {
          tool: 'list_accounts',
          arguments: {},
        },
        retry: {
          tool: 'update_account',
          arguments: {
            accountId: 999,
            name: 'Missing',
          },
        },
      },
    })
  })

  it('tells the Agent how to discover a valid Category before retrying', async () => {
    const vaultPath = createTemporaryVaultPath()
    const connection = await connectTestClient({})
    client = connection.client
    server = connection.server

    await client.callTool({
      name: 'initialize_vault',
      arguments: { path: vaultPath },
    })
    const result = await client.callTool({
      name: 'update_category',
      arguments: {
        categoryId: 999,
        name: 'Missing',
      },
    })

    expect(result.content).toEqual([
      {
        type: 'text',
        text:
          'Category 999 does not exist. Call list_categories to inspect valid Category IDs in ' +
          'the selected Vault before retrying update_category.',
      },
    ])
    expect(result._meta).toMatchObject({
      'fin/error': {
        code: 'ENTITY_NOT_FOUND',
        recovery: {
          tool: 'list_categories',
          arguments: {},
        },
      },
    })
  })

  it('tells the Agent how to discover a valid Transaction before retrying', async () => {
    const vaultPath = createTemporaryVaultPath()
    const connection = await connectTestClient({})
    client = connection.client
    server = connection.server

    await client.callTool({
      name: 'initialize_vault',
      arguments: { path: vaultPath },
    })
    const result = await client.callTool({
      name: 'get_income_expense_transaction',
      arguments: {
        transactionId: 999,
      },
    })

    expect(result.content).toEqual([
      {
        type: 'text',
        text:
          'Income or Expense Transaction 999 does not exist. Call ' +
          'list_income_expense_transactions to inspect valid Income or Expense Transaction IDs ' +
          'in the selected Vault before retrying get_income_expense_transaction.',
      },
    ])
    expect(result._meta).toMatchObject({
      'fin/error': {
        code: 'ENTITY_NOT_FOUND',
        recovery: {
          tool: 'list_income_expense_transactions',
          arguments: {},
        },
      },
    })
  })

  it('offers safe choices when an archived Account is selected', async () => {
    const vaultPath = createTemporaryVaultPath()
    const connection = await connectTestClient({})
    client = connection.client
    server = connection.server

    await client.callTool({
      name: 'initialize_vault',
      arguments: { path: vaultPath },
    })
    const created = await client.callTool({
      name: 'create_account',
      arguments: {
        name: 'Daily Cash',
        nature: 'asset',
        currency: 'KRW',
      },
    })
    const accountId = (
      created.structuredContent as {
        account: { id: number }
      }
    ).account.id
    await client.callTool({
      name: 'archive_account',
      arguments: { accountId },
    })

    const result = await client.callTool({
      name: 'record_income_expense',
      arguments: {
        kind: 'expense',
        accountId,
        amountMinor: 5_000,
        occurredOn: '2026-07-28',
      },
    })

    expect(result.content).toEqual([
      {
        type: 'text',
        text:
          `Archived Account ${accountId} ("Daily Cash") cannot receive new Transactions. ` +
          'Call list_accounts to choose an active Account in the selected Vault. Only call ' +
          `reactivate_account for Account ${accountId} after the user confirms reactivation, ` +
          'then retry record_income_expense.',
      },
    ])
    expect(result._meta).toEqual({
      'fin/error': {
        code: 'ENTITY_ARCHIVED',
        retryable: true,
        recovery: {
          tool: 'list_accounts',
          arguments: {},
        },
        alternative: {
          tool: 'reactivate_account',
          arguments: { accountId },
          requiresConfirmation: true,
        },
        retry: {
          tool: 'record_income_expense',
          arguments: {
            kind: 'expense',
            accountId,
            amountMinor: 5_000,
            occurredOn: '2026-07-28',
          },
        },
      },
    })
  })

  it('identifies the prerequisite tool before archiving a default Account', async () => {
    const vaultPath = createTemporaryVaultPath()
    const connection = await connectTestClient({})
    client = connection.client
    server = connection.server

    await client.callTool({
      name: 'initialize_vault',
      arguments: { path: vaultPath },
    })
    const created = await client.callTool({
      name: 'create_account',
      arguments: {
        name: 'Daily Cash',
        nature: 'asset',
        currency: 'KRW',
      },
    })
    const accountId = (
      created.structuredContent as {
        account: { id: number }
      }
    ).account.id
    await client.callTool({
      name: 'set_default_account',
      arguments: { kind: 'income', accountId },
    })

    const result = await client.callTool({
      name: 'archive_account',
      arguments: { accountId },
    })

    expect(result.content).toEqual([
      {
        type: 'text',
        text:
          `Account ${accountId} ("Daily Cash") is configured as the default Income Account. ` +
          'Call set_default_account with kind "income" and accountId null, then retry ' +
          'archive_account.',
      },
    ])
    expect(result._meta).toEqual({
      'fin/error': {
        code: 'PREREQUISITE_REQUIRED',
        retryable: true,
        recovery: {
          steps: [
            {
              tool: 'set_default_account',
              arguments: {
                kind: 'income',
                accountId: null,
              },
            },
          ],
        },
        retry: {
          tool: 'archive_account',
          arguments: { accountId },
        },
      },
    })
  })

  it('identifies fields that must be corrected before retrying invalid input', async () => {
    const vaultPath = createTemporaryVaultPath()
    const connection = await connectTestClient({})
    client = connection.client
    server = connection.server

    await client.callTool({
      name: 'initialize_vault',
      arguments: { path: vaultPath },
    })
    const result = await client.callTool({
      name: 'create_account',
      arguments: {
        name: 'Daily Cash',
        nature: 'asset',
        currency: 'KR',
      },
    })

    expect(result.content).toEqual([
      {
        type: 'text',
        text:
          'Account currency must be a three-letter code such as KRW or USD. Correct the currency ' +
          'field before retrying create_account.',
      },
    ])
    expect(result._meta).toEqual({
      'fin/error': {
        code: 'INVALID_INPUT',
        retryable: true,
        recovery: {
          action: 'correct_arguments',
          fields: ['currency'],
        },
      },
    })
  })

  it('identifies a blank Vault path as input to correct', async () => {
    const connection = await connectTestClient({})
    client = connection.client
    server = connection.server

    const result = await client.callTool({
      name: 'initialize_vault',
      arguments: { path: '   ' },
    })

    expect(result.content).toEqual([
      {
        type: 'text',
        text: 'Vault path must not be empty. Correct the path field before retrying initialize_vault.',
      },
    ])
    expect(result._meta).toEqual({
      'fin/error': {
        code: 'INVALID_INPUT',
        retryable: true,
        recovery: {
          action: 'correct_arguments',
          fields: ['path'],
        },
      },
    })
  })

  it('identifies a missing kind-specific field as input to correct', async () => {
    const connection = await connectTestClient({})
    client = connection.client
    server = connection.server

    const result = await client.callTool({
      name: 'edit_transaction',
      arguments: {
        transactionId: 1,
        kind: 'expense',
        occurredOn: '2026-07-28',
        amountMinor: 5_000,
      },
    })

    expect(result.content).toEqual([
      {
        type: 'text',
        text:
          'accountId is required for this Transaction kind. Correct the accountId field before ' +
          'retrying edit_transaction.',
      },
    ])
    expect(result._meta).toEqual({
      'fin/error': {
        code: 'INVALID_INPUT',
        retryable: true,
        recovery: {
          action: 'correct_arguments',
          fields: ['accountId'],
        },
      },
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
      arguments: {},
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
      arguments: { kind: 'income', accountId: account.id },
    })
    const cleared = await client.callTool({
      name: 'set_default_account',
      arguments: { kind: 'income', accountId: null },
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
      arguments: { accountId: activeAccount.id },
    })
    const reactivateResult = await client.callTool({
      name: 'reactivate_account',
      arguments: { accountId: activeAccount.id },
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
        name: 'Dining',
        parentId: 2,
      },
    })
    const listed = await client.callTool({
      name: 'list_categories',
      arguments: {},
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
      arguments: { categoryId: activeCategory.id },
    })
    const reactivateResult = await client.callTool({
      name: 'reactivate_category',
      arguments: { categoryId: activeCategory.id },
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
      arguments: {},
    })
    const inspected = await client.callTool({
      name: 'get_income_expense_transaction',
      arguments: { transactionId: transaction.id },
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
      arguments: { transactionId: 12 },
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

  it('records a target-balance Adjustment with previous, delta, and resulting balances', async () => {
    const transaction = createAdjustmentTransaction()
    const requests: Array<{
      accountId: number
      occurredOn: string
      amountMinor: number | undefined
      targetBalanceMinor: number | undefined
      memo: string | null | undefined
    }> = []
    const result = {
      action: 'created' as const,
      transaction,
      previousBalanceMinor: -2_000,
      adjustmentAmountMinor: 1_500,
      resultingBalanceMinor: -500,
      requestedTargetBalanceMinor: -500,
    }
    const connection = await connectTestClient({
      recordAdjustment: (_path, request) => {
        requests.push({
          accountId: request.accountId,
          occurredOn: request.occurredOn,
          amountMinor: request.amountMinor,
          targetBalanceMinor: request.targetBalanceMinor,
          memo: request.memo,
        })
        return result
      },
    })
    client = connection.client
    server = connection.server

    const response = await client.callTool({
      name: 'record_adjustment',
      arguments: {
        accountId: 6,
        occurredOn: '2026-07-27',
        targetBalanceMinor: -500,
        memo: 'reconcile',
      },
    })

    expect(requests).toEqual([
      {
        accountId: 6,
        occurredOn: '2026-07-27',
        amountMinor: undefined,
        targetBalanceMinor: -500,
        memo: 'reconcile',
      },
    ])
    expect(response.content).toEqual([
      {
        type: 'text',
        text:
          'Adjustment Transaction 18 for Liability Account "Card" (ID 6, USD), ' +
          '1500 minor units on 2026-07-27, memo "reconcile". ' +
          'Requested target balance: -500 USD. Balance: -2000 + (1500) = -500 minor units.',
      },
    ])
    expect(response.structuredContent).toEqual(result)
  })

  it('records a Transfer with both Accounts, amounts, currencies, date, and balances', async () => {
    const transaction = createTransferTransaction()
    const requests: Array<{
      sourceAccountId: number
      sourceAmountMinor: number
      destinationAccountId: number
      destinationAmountMinor: number
      occurredOn: string
      memo: string | null | undefined
    }> = []
    const result = {
      action: 'created' as const,
      transaction,
      sourcePreviousBalanceMinor: 50_000,
      sourceResultingBalanceMinor: 40_000,
      destinationPreviousBalanceMinor: 0,
      destinationResultingBalanceMinor: 135_000,
    }
    const connection = await connectTestClient({
      recordTransfer: (_path, request) => {
        requests.push({
          sourceAccountId: request.sourceAccountId,
          sourceAmountMinor: request.sourceAmountMinor,
          destinationAccountId: request.destinationAccountId,
          destinationAmountMinor: request.destinationAmountMinor,
          occurredOn: request.occurredOn,
          memo: request.memo,
        })
        return result
      },
    })
    client = connection.client
    server = connection.server

    const response = await client.callTool({
      name: 'record_transfer',
      arguments: {
        sourceAccountId: 3,
        sourceAmountMinor: 10_000,
        destinationAccountId: 4,
        destinationAmountMinor: 135_000,
        occurredOn: '2026-07-27',
        memo: 'exchange',
      },
    })

    expect(requests).toEqual([
      {
        sourceAccountId: 3,
        sourceAmountMinor: 10_000,
        destinationAccountId: 4,
        destinationAmountMinor: 135_000,
        occurredOn: '2026-07-27',
        memo: 'exchange',
      },
    ])
    expect(response.content).toEqual([
      {
        type: 'text',
        text:
          'Transfer Transaction 25 on 2026-07-27, memo "exchange": ' +
          'Asset source Account "Dollars" (ID 3) sends 10000 USD minor units; ' +
          'Asset destination Account "Won" (ID 4) receives 135000 KRW minor units. ' +
          'Source balance: 50000 to 40000; destination balance: 0 to 135000 minor units.',
      },
    ])
    expect(response.structuredContent).toEqual(result)
  })

  it('records a linked Refund as a negative Expense and confirms the relation', async () => {
    const requests: Array<{
      accountId: number
      amountMinor: number
      occurredOn: string
      memo: string | null | undefined
      originalExpenseId: number | null | undefined
    }> = []
    const result: RecordRelatedExpenseResult = {
      action: 'created',
      transaction: createIncomeExpenseTransaction({
        id: 31,
        amountMinor: -8_000,
        memo: 'returned item',
      }),
      relation: {
        kind: 'refund_of',
        targetTransactionId: 12,
      },
      previousBalanceMinor: 220_000,
      resultingBalanceMinor: 228_000,
    }
    const connection = await connectTestClient({
      recordRefund: (_path, request) => {
        requests.push({
          accountId: request.accountId,
          amountMinor: request.amountMinor,
          occurredOn: request.occurredOn,
          memo: request.memo,
          originalExpenseId: request.originalExpenseId,
        })
        return result
      },
    })
    client = connection.client
    server = connection.server

    const response = await client.callTool({
      name: 'record_refund',
      arguments: {
        accountId: 4,
        amountMinor: 8_000,
        occurredOn: '2026-07-28',
        memo: 'returned item',
        originalExpenseId: 12,
      },
    })

    expect(requests).toEqual([
      {
        accountId: 4,
        amountMinor: 8_000,
        occurredOn: '2026-07-28',
        memo: 'returned item',
        originalExpenseId: 12,
      },
    ])
    expect(response.content).toEqual([
      {
        type: 'text',
        text:
          'Recorded Refund as Asset Account "Bank" (ID 4, KRW) — Expense Transaction 31, ' +
          '-8000 minor units on 2026-07-27, memo "returned item". ' +
          'Related to original Expense Transaction 12. ' +
          'Account balance changed from 220000 to 228000 minor units.',
      },
    ])
    expect(response.structuredContent).toEqual(result)
  })

  it('records a Transfer fee as a positive Expense related to its Transfer', async () => {
    const result: RecordRelatedExpenseResult = {
      action: 'created',
      transaction: createIncomeExpenseTransaction({
        id: 32,
        amountMinor: 900,
        memo: 'wire fee',
      }),
      relation: {
        kind: 'fee_for',
        targetTransactionId: 25,
      },
      previousBalanceMinor: 40_000,
      resultingBalanceMinor: 39_100,
    }
    const connection = await connectTestClient({
      recordTransferFee: () => result,
    })
    client = connection.client
    server = connection.server

    const response = await client.callTool({
      name: 'record_transfer_fee',
      arguments: {
        accountId: 4,
        amountMinor: 900,
        occurredOn: '2026-07-28',
        memo: 'wire fee',
        transferId: 25,
      },
    })

    expect(response.content).toEqual([
      {
        type: 'text',
        text:
          'Recorded Transfer fee as Asset Account "Bank" (ID 4, KRW) — ' +
          'Expense Transaction 32, 900 minor units on 2026-07-27, memo "wire fee". ' +
          'Related to Transfer Transaction 25. ' +
          'Account balance changed from 40000 to 39100 minor units.',
      },
    ])
    expect(response.structuredContent).toEqual(result)
  })

  it('inspects related Transactions and requires confirmation before multi-Transaction changes', async () => {
    const inspection: TransactionRelationInspection = {
      transaction: createTransactionSnapshot({
        id: 25,
        kind: 'transfer',
        accountId: null,
        amountMinor: null,
        sourceAccountId: 3,
        sourceAmountMinor: 10_000,
        destinationAccountId: 4,
        destinationAmountMinor: 135_000,
        memo: 'exchange',
      }),
      relatedTransactions: [
        {
          relationKind: 'fee_for',
          direction: 'incoming',
          transaction: createTransactionSnapshot({
            id: 32,
            amountMinor: 900,
            memo: 'wire fee',
          }),
        },
      ],
      requiresConfirmationBeforeMultiTransactionChange: true,
    }
    const connection = await connectTestClient({
      inspectTransactionRelations: () => inspection,
    })
    client = connection.client
    server = connection.server

    const response = await client.callTool({
      name: 'inspect_transaction_relations',
      arguments: { transactionId: 25 },
    })

    expect(response.content).toEqual([
      {
        type: 'text',
        text:
          'Transfer Transaction 25, source Account 3 sends 10000; ' +
          'destination Account 4 receives 135000 minor units on 2026-07-27, memo "exchange"\n' +
          'incoming fee_for: Expense Transaction 32, Account 4, 900 minor units ' +
          'on 2026-07-27, memo "wire fee"\n' +
          'Explicit confirmation is required before changing multiple related Transactions.',
      },
    ])
    expect(response.structuredContent).toEqual(inspection)
  })

  it('edits a Transaction through a complete replacement and reports related records', async () => {
    const previousTransaction = createLifecycleTransaction()
    const transaction = createLifecycleTransaction({
      amountMinor: 25_000,
      occurredOn: '2026-07-28',
      memo: 'corrected groceries',
    })
    const result: EditTransactionResult = {
      action: 'updated',
      previousTransaction,
      transaction,
      balanceChanges: [
        {
          accountId: 4,
          currency: 'KRW',
          previousBalanceMinor: 220_000,
          resultingBalanceMinor: 225_000,
        },
      ],
      relatedTransactions: transaction.relations,
      requiresConfirmationBeforeMultiTransactionChange: true,
    }
    const requests: unknown[] = []
    const connection = await connectTestClient({
      editTransaction: (_path, request) => {
        requests.push(request)
        return result
      },
    })
    client = connection.client
    server = connection.server

    const response = await client.callTool({
      name: 'edit_transaction',
      arguments: {
        transactionId: 12,
        kind: 'expense',
        accountId: 4,
        amountMinor: 25_000,
        occurredOn: '2026-07-28',
        memo: 'corrected groceries',
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
        replacement: {
          kind: 'expense',
          accountId: 4,
          amountMinor: 25_000,
          occurredOn: '2026-07-28',
          memo: 'corrected groceries',
          assignments: [
            {
              categoryId: 8,
              amountMinor: 20_000,
              origin: 'inferred',
            },
          ],
          relation: undefined,
        },
      },
    ])
    expect(response.content).toEqual([
      {
        type: 'text',
        text:
          'Edited Expense Transaction 12 on 2026-07-27, memo "groceries": ' +
          'Account "Bank" (ID 4), 30000 KRW, inferred Category "Living > Food" 20000 KRW ' +
          'to Expense Transaction 12 on 2026-07-28, memo "corrected groceries": ' +
          'Account "Bank" (ID 4), 25000 KRW, inferred Category "Living > Food" 20000 KRW. ' +
          'Account 4 KRW balance changed from 220000 to 225000. ' +
          '1 related Transaction(s) were identified; explicit confirmation is required ' +
          'before changing more than this Transaction.',
      },
    ])
    expect(response.structuredContent).toEqual(result)
  })

  it('deletes one Transaction without claiming related Transactions were changed', async () => {
    const transaction = createLifecycleTransaction()
    const result: DeleteTransactionResult = {
      action: 'deleted',
      transaction,
      balanceChanges: [
        {
          accountId: 4,
          currency: 'KRW',
          previousBalanceMinor: 220_000,
          resultingBalanceMinor: 250_000,
        },
      ],
      relatedTransactions: transaction.relations,
      requiresConfirmationBeforeMultiTransactionChange: true,
    }
    const connection = await connectTestClient({
      deleteTransaction: () => result,
    })
    client = connection.client
    server = connection.server

    const response = await client.callTool({
      name: 'delete_transaction',
      arguments: { transactionId: 12 },
    })

    expect(response.content).toEqual([
      {
        type: 'text',
        text:
          'Deleted Expense Transaction 12 on 2026-07-27, memo "groceries": ' +
          'Account "Bank" (ID 4), 30000 KRW, inferred Category "Living > Food" 20000 KRW. ' +
          'Account 4 KRW balance changed from 220000 to 250000. ' +
          '1 related Transaction(s) were identified; explicit confirmation is required ' +
          'before changing more than this Transaction.',
      },
    ])
    expect(response.structuredContent).toEqual(result)
  })

  it('lists immutable Transaction Change Records using their natural-language descriptions', async () => {
    const changeRecord: TransactionChangeRecord = {
      id: 41,
      transactionId: 12,
      action: 'deleted',
      payload: {
        action: 'deleted',
        transaction: createLifecycleTransaction(),
      },
      recordedAt: '2026-07-28T01:02:03.000Z',
      description: 'Deleted Expense Transaction 12 on 2026-07-27: Account 4 "Bank", 30000 KRW.',
    }
    const connection = await connectTestClient({
      listTransactionChangeRecords: () => [changeRecord],
    })
    client = connection.client
    server = connection.server

    const response = await client.callTool({
      name: 'list_transaction_change_records',
      arguments: { transactionId: 12 },
    })

    expect(response.content).toEqual([
      {
        type: 'text',
        text:
          'Change Record 41 at 2026-07-28T01:02:03.000Z: ' +
          'Deleted Expense Transaction 12 on 2026-07-27: ' +
          'Account 4 "Bank", 30000 KRW.',
      },
    ])
    expect(response.structuredContent).toEqual({ changeRecords: [changeRecord] })
  })

  it('recreates a deleted Transaction with a new identity and discloses omitted relations', async () => {
    const omittedIncomingRelations = createLifecycleTransaction().relations
    const result: RecreateTransactionResult = {
      action: 'created',
      recreatedFromChangeRecordId: 41,
      deletedTransactionId: 12,
      transaction: createLifecycleTransaction({
        id: 40,
        relations: [],
      }),
      balanceChanges: [
        {
          accountId: 4,
          currency: 'KRW',
          previousBalanceMinor: 250_000,
          resultingBalanceMinor: 220_000,
        },
      ],
      omittedIncomingRelations,
    }
    const connection = await connectTestClient({
      recreateTransaction: () => result,
    })
    client = connection.client
    server = connection.server

    const response = await client.callTool({
      name: 'recreate_transaction',
      arguments: { deletionChangeRecordId: 41 },
    })

    expect(response.content).toEqual([
      {
        type: 'text',
        text:
          'Recreated deleted Transaction 12 as Expense Transaction 40 on 2026-07-27, ' +
          'memo "groceries": Account "Bank" (ID 4), 30000 KRW, ' +
          'inferred Category "Living > Food" 20000 KRW from Change Record 41. ' +
          'Account 4 KRW balance changed from 250000 to 220000. ' +
          '1 incoming relation(s) were not reattached because related Transactions ' +
          'are never changed implicitly.',
      },
    ])
    expect(response.structuredContent).toEqual(result)
  })

  it('queries Account balances and net worth separately by currency', async () => {
    const result: BalanceQueryResult = {
      accounts: [createAccount({ balanceMinor: 12_500 })],
      netWorthByCurrency: [{ currency: 'KRW', amountMinor: 12_500 }],
    }
    const connection = await connectTestClient({
      queryBalances: () => result,
    })
    client = connection.client
    server = connection.server

    const response = await client.callTool({
      name: 'query_balances',
      arguments: {},
    })

    expect(response.content).toEqual([
      {
        type: 'text',
        text:
          'Account 7: Asset Account "Daily Cash" ' +
          '(KRW, balance 12500 minor units, archived: no)\n' +
          'Net worth: 12500 KRW.',
      },
    ])
    expect(response.structuredContent).toEqual(result)
  })

  it('queries filtered Transactions with evidence-backed Income and Expense totals', async () => {
    const result: TransactionQueryResult = {
      filters: {
        dateFrom: '2026-07-27',
        dateTo: '2026-07-28',
        accountId: 4,
        kinds: ['expense'],
        memoContains: 'coffee',
      },
      transactions: [createQueryExpense()],
      incomeExpenseTotalsByCurrency: [
        {
          currency: 'KRW',
          incomeMinor: 0,
          expenseMinor: 30_000,
          netIncomeMinor: -30_000,
          transactionIds: [12],
        },
      ],
    }
    const requests: unknown[] = []
    const connection = await connectTestClient({
      queryTransactions: (_path, filters) => {
        requests.push(filters)
        return result
      },
    })
    client = connection.client
    server = connection.server

    const response = await client.callTool({
      name: 'query_transactions',
      arguments: {
        dateFrom: '2026-07-27',
        dateTo: '2026-07-28',
        accountId: 4,
        kinds: ['expense'],
        memoContains: 'coffee',
      },
    })

    expect(requests).toEqual([
      {
        dateFrom: '2026-07-27',
        dateTo: '2026-07-28',
        accountId: 4,
        kinds: ['expense'],
        memoContains: 'coffee',
      },
    ])
    expect(response.content).toEqual([
      {
        type: 'text',
        text:
          'Matched 1 Transaction(s).\n' +
          'Expense Transaction 12 on 2026-07-27, memo "coffee": ' +
          'Account "Bank" (ID 4), 30000 KRW; explicit Category "Living > Food" ' +
          '20000 KRW; uncategorized 10000 KRW; no relations\n' +
          'Income and Expense totals: KRW Income 0, Expense 30000, ' +
          'net Income -30000; evidence Transactions 12',
      },
    ])
    expect(response.structuredContent).toEqual(result)
  })

  it('queries Category rollups and uncategorized spending with Transaction evidence', async () => {
    const result: SpendingQueryResult = {
      filters: {
        dateFrom: null,
        dateTo: null,
        accountId: null,
        memoContains: 'coffee',
        categoryId: 8,
      },
      transactions: [createQueryExpense()],
      expenseTotalsByCurrency: [{ currency: 'KRW', amountMinor: 30_000 }],
      uncategorizedByCurrency: [{ currency: 'KRW', amountMinor: 10_000 }],
      categoryRollups: [
        {
          categoryId: 8,
          categoryPath: 'Living > Food',
          currency: 'KRW',
          amountMinor: 20_000,
          transactionIds: [12],
        },
      ],
    }
    const connection = await connectTestClient({
      querySpending: () => result,
    })
    client = connection.client
    server = connection.server

    const response = await client.callTool({
      name: 'query_spending',
      arguments: {
        memoContains: 'coffee',
        categoryId: 8,
      },
    })

    expect(response.content).toEqual([
      {
        type: 'text',
        text:
          'Matched 1 Expense Transaction(s).\n' +
          'Expense totals: 30000 KRW.\n' +
          'Uncategorized: 10000 KRW.\n' +
          'Category rollups:\n' +
          'Category "Living > Food" (ID 8): 20000 KRW; evidence Transactions 12\n' +
          'Expense Transaction 12 on 2026-07-27, memo "coffee": ' +
          'Account "Bank" (ID 4), 30000 KRW; explicit Category "Living > Food" ' +
          '20000 KRW; uncategorized 10000 KRW; no relations',
      },
    ])
    expect(response.structuredContent).toEqual(result)
  })

  it('returns Agent-facing ambiguity candidates without claiming a mutation', async () => {
    const result: AgentTransactionResult = {
      status: 'needs_clarification',
      reason: 'transaction_kind_ambiguity',
      message:
        'Income and Expense are both plausible; choose the Transaction kind before recording.',
      candidates: {
        transactionKinds: [
          { kind: 'income', label: 'Income' },
          { kind: 'expense', label: 'Expense' },
        ],
        accounts: [],
        categories: [],
      },
      duplicateMatches: [],
      proposedCategory: null,
      receipt: null,
    }
    const connection = await connectTestClient({
      recordAgentTransaction: () => result,
    })
    client = connection.client
    server = connection.server

    const response = await client.callTool({
      name: 'record_agent_transaction',
      arguments: {
        amountMinor: 5_000,
      },
    })

    expect(response.content).toEqual([
      {
        type: 'text',
        text:
          'Income and Expense are both plausible; choose the Transaction kind before recording.\n' +
          'Transaction kind candidates: Income, Expense.\n' +
          'No Vault mutation was applied.',
      },
    ])
    expect(response.structuredContent).toEqual(result)
  })

  it('returns every likely duplicate material value before Agent mutation', async () => {
    const result: AgentTransactionResult = {
      status: 'confirmation_required',
      reason: 'duplicate_confirmation',
      message:
        'A likely duplicate matches the applied date, Account, kind, amount, and memo; ' +
        'confirm that this is a legitimate duplicate before recording it.',
      candidates: {
        transactionKinds: [],
        accounts: [],
        categories: [],
      },
      duplicateMatches: [
        {
          transactionId: 12,
          kind: 'expense',
          occurredOn: '2026-07-27',
          account: {
            id: 4,
            name: 'Bank',
            nature: 'asset',
            currency: 'KRW',
            archived: false,
          },
          amountMinor: 5_000,
          memo: 'coffee',
        },
      ],
      proposedCategory: null,
      receipt: null,
    }
    const connection = await connectTestClient({
      recordAgentTransaction: () => result,
    })
    client = connection.client
    server = connection.server

    const response = await client.callTool({
      name: 'record_agent_transaction',
      arguments: {
        kind: 'expense',
        accountId: 4,
        amountMinor: 5_000,
        occurredOn: '2026-07-27',
        memo: 'coffee',
      },
    })

    expect(response.content).toEqual([
      {
        type: 'text',
        text:
          'A likely duplicate matches the applied date, Account, kind, amount, and memo; ' +
          'confirm that this is a legitimate duplicate before recording it.\n' +
          'Likely duplicates: Expense Transaction 12, Account "Bank" (ID 4), ' +
          '5000 KRW on 2026-07-27, memo "coffee".\n' +
          'No Vault mutation was applied.',
      },
    ])
    expect(response.structuredContent).toEqual(result)
  })

  it('returns a detailed Agent mutation receipt with defaulted and inferred sources', async () => {
    const transaction = createIncomeExpenseTransaction({
      amountMinor: 5_000,
      memo: null,
    })
    const categoryAssignment = createCategoryAssignment({
      amountMinor: 5_000,
      origin: 'inferred',
    })
    const result: AgentTransactionResult = {
      status: 'recorded',
      reason: null,
      message:
        'Recorded the Transaction with all applied, defaulted, and inferred values disclosed.',
      candidates: {
        transactionKinds: [],
        accounts: [],
        categories: [],
      },
      duplicateMatches: [],
      proposedCategory: null,
      receipt: {
        transaction,
        previousBalanceMinor: 20_000,
        resultingBalanceMinor: 15_000,
        categoryAssignment,
        uncategorizedAmountMinor: 0,
        createdCategory: null,
        duplicateConfirmation: 'not_needed',
        applied: {
          kind: { value: 'expense', source: 'explicit' },
          account: { value: transaction.account, source: 'default' },
          amountMinor: { value: 5_000, source: 'explicit' },
          occurredOn: { value: '2026-07-27', source: 'default' },
          memo: { value: null, source: 'default_no_memo' },
          category: {
            value: { id: 8, path: 'Living > Food' },
            source: 'inferred',
          },
          categoryAmountMinor: {
            value: 5_000,
            source: 'default_full_amount',
          },
        },
      },
    }
    const connection = await connectTestClient({
      recordAgentTransaction: () => result,
    })
    client = connection.client
    server = connection.server

    const response = await client.callTool({
      name: 'record_agent_transaction',
      arguments: {
        kind: 'expense',
        amountMinor: 5_000,
        categoryQuery: 'Food',
      },
    })

    expect(response.content).toEqual([
      {
        type: 'text',
        text:
          'Recorded Expense Transaction 12: Account "Bank" (ID 4, KRW, default); ' +
          '5000 minor units (explicit); date 2026-07-27 (default); ' +
          'no memo (default_no_memo); Category "Living > Food" (ID 8, inferred), ' +
          'assigned 5000 minor units (default_full_amount); uncategorized 0 minor units. ' +
          'Account balance changed from 20000 to 15000. ' +
          'No likely duplicate required confirmation.',
      },
    ])
    expect(response.structuredContent).toEqual(result)
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

  function createAdjustmentTransaction(
    overrides: Partial<AdjustmentTransaction> = {},
  ): AdjustmentTransaction {
    return {
      id: 18,
      kind: 'adjustment',
      occurredOn: '2026-07-27',
      account: {
        id: 6,
        name: 'Card',
        nature: 'liability',
        currency: 'USD',
        archived: false,
      },
      amountMinor: 1_500,
      memo: 'reconcile',
      ...overrides,
    }
  }

  function createTransferTransaction(
    overrides: Partial<TransferTransaction> = {},
  ): TransferTransaction {
    return {
      id: 25,
      kind: 'transfer',
      occurredOn: '2026-07-27',
      source: {
        account: {
          id: 3,
          name: 'Dollars',
          nature: 'asset',
          currency: 'USD',
          archived: false,
        },
        amountMinor: 10_000,
      },
      destination: {
        account: {
          id: 4,
          name: 'Won',
          nature: 'asset',
          currency: 'KRW',
          archived: false,
        },
        amountMinor: 135_000,
      },
      memo: 'exchange',
      ...overrides,
    }
  }

  function createTransactionSnapshot(
    overrides: Partial<TransactionSnapshot> = {},
  ): TransactionSnapshot {
    return {
      id: 12,
      kind: 'expense',
      occurredOn: '2026-07-27',
      memo: 'groceries',
      accountId: 4,
      amountMinor: 30_000,
      sourceAccountId: null,
      sourceAmountMinor: null,
      destinationAccountId: null,
      destinationAmountMinor: null,
      ...overrides,
    }
  }

  function createLifecycleTransaction(
    overrides: Partial<IncomeExpenseTransactionState> = {},
  ): IncomeExpenseTransactionState {
    return {
      id: 12,
      kind: 'expense',
      occurredOn: '2026-07-27',
      memo: 'groceries',
      account: {
        id: 4,
        name: 'Bank',
        nature: 'asset',
        currency: 'KRW',
        archived: false,
      },
      amountMinor: 30_000,
      assignments: [
        {
          categoryId: 8,
          categoryPath: 'Living > Food',
          amountMinor: 20_000,
          origin: 'inferred',
        },
      ],
      relations: [
        {
          relationKind: 'refund_of',
          direction: 'incoming',
          relatedTransaction: {
            id: 31,
            kind: 'expense',
            occurredOn: '2026-07-28',
            memo: 'returned item',
          },
        },
      ],
      ...overrides,
    }
  }

  function createQueryExpense(): QueryIncomeExpenseTransaction {
    return {
      id: 12,
      kind: 'expense',
      occurredOn: '2026-07-27',
      memo: 'coffee',
      relations: [],
      account: {
        id: 4,
        name: 'Bank',
        nature: 'asset',
        currency: 'KRW',
        archived: false,
      },
      amountMinor: 30_000,
      assignments: [
        {
          categoryId: 8,
          categoryPath: 'Living > Food',
          amountMinor: 20_000,
          origin: 'explicit',
          currency: 'KRW',
        },
      ],
      uncategorizedAmountMinor: 10_000,
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
    initialVaultPath: string | null = '/vaults/main',
  ): Promise<{ client: Client; server: McpServer; selectedVaultPath: () => string | undefined }> {
    let vaultPath = initialVaultPath ?? undefined
    const vaultLocationStore: VaultLocationStore = {
      get: () => vaultPath,
      save: (selectedPath) => {
        vaultPath = selectedPath
      },
    }
    const server = createFinServer(operations, vaultLocationStore)
    const client = new Client({ name: 'fin-test-client', version: '0.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])

    return { client, server, selectedVaultPath: () => vaultPath }
  }

  function createTemporaryVaultPath(): string {
    const parentPath = mkdtempSync(join(tmpdir(), 'fin-mcp-test-'))
    temporaryDirectories.push(parentPath)
    return join(parentPath, 'vault')
  }
})
