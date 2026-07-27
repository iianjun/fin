import type { Account, VaultState } from '@fin/core'
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
