import type { VaultState } from '@fin/core'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { afterEach, describe, expect, it } from 'vitest'
import { createFinServer, type VaultOperations } from './server.js'

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
    operations: VaultOperations,
  ): Promise<{ client: Client; server: McpServer }> {
    const server = createFinServer(operations)
    const client = new Client({ name: 'fin-test-client', version: '0.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])

    return { client, server }
  }
})
