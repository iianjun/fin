import { afterEach, expect, test, vi } from 'vitest'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { McpServer } from '@modelcontextprotocol/server'
import { createFin, createVault, listVaults, FinError } from '@fin/core'
import { createSqliteAdapter } from '@fin/sqlite'
import { createFinTools, type FinVaultAccess } from './index.js'
import { registerFinTools } from './mcp.js'

const disposers: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose()
})

async function connect(access?: FinVaultAccess) {
  const storage = createSqliteAdapter({ filename: ':memory:' })
  disposers.push(storage.close)
  const server = new McpServer({ name: 'fin-test', version: '0.0.0' })
  const client = new Client({ name: 'fin-consumer', version: '0.0.0' })
  const authorized: FinVaultAccess = access ?? {
    listVaults: (options) => listVaults({ storage, ...options }),
    createVault: (input) => createVault({ storage, ...input }),
    getFin: async (vaultId) => createFin({ storage, vaultId }),
  }
  registerFinTools(server, createFinTools({ access: authorized }))
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  disposers.push(
    () => server.close(),
    () => client.close(),
  )
  return { client, storage }
}

test('publishes selected schemas and preserves financial receipts and stale-revision recovery over MCP', async () => {
  const { client, storage } = await connect()
  const { tools } = await client.listTools()
  expect(tools.find((tool) => tool.name === 'create_account')?.inputSchema).toMatchObject({
    required: expect.arrayContaining(['vaultId', 'name', 'nature', 'currency']),
  })
  const created = await client.callTool({ name: 'create_vault', arguments: { name: 'Home' } })
  expect(created.isError).toBeFalsy()
  const [vault] = await listVaults({ storage })
  if (!vault) throw new Error('Expected created Vault')
  const fin = createFin({ storage, vaultId: vault.id })
  const { account } = await fin.createAccount({ name: 'Cash', nature: 'asset', currency: 'KRW' })
  const receipt = await client.callTool({
    name: 'record_income_expense',
    arguments: {
      vaultId: vault.id,
      kind: 'income',
      accountId: account.id,
      amountMinor: 300,
      occurredOn: '2026-11-08',
    },
  })
  const [transaction] = await fin.listTransactions()
  if (!transaction) throw new Error('Expected transaction')
  expect(receipt.structuredContent).toMatchObject({ data: { changed: true, transaction } })
  const edit = {
    vaultId: vault.id,
    id: transaction.id,
    expectedRevision: transaction.revision,
    patch: { memo: 'Updated' },
  }
  await client.callTool({ name: 'edit_transaction', arguments: edit })
  const stale = await client.callTool({ name: 'edit_transaction', arguments: edit })
  const error = await fin.editTransaction(edit).catch((cause) => cause)
  expect(error).toBeInstanceOf(FinError)
  expect(stale.isError).toBe(true)
  expect(stale.structuredContent).toEqual({
    error: {
      code: error.code,
      message: error.message,
      application: error.application,
      recovery: error.recovery,
    },
  })
  const invalid = await client.callTool({
    name: 'create_account',
    arguments: { name: 'Missing Vault' },
  })
  expect(invalid.isError).toBe(true)
})

test.each([
  new FinError('FORBIDDEN', 'Denied', 'Choose an authorized Vault', 'not_applied', {
    vaultId: 'private',
  }),
  new FinError('OUTCOME_UNKNOWN', 'Response lost', 'Inspect state and history', 'unknown', {
    id: 'transaction',
  }),
  new FinError(
    'STORAGE_FAILURE',
    'Confirmed rollback',
    'Fix storage and reconsider',
    'not_applied',
  ),
])('preserves exact $code wire fields with no automatic replay', async (error) => {
  const getFin = vi.fn().mockRejectedValue(error)
  const { client } = await connect({ getFin, listVaults: vi.fn(), createVault: vi.fn() })
  const result = await client.callTool({
    name: 'query_balances',
    arguments: { vaultId: 'private' },
  })
  const expected = {
    error: {
      code: error.code,
      message: error.message,
      application: error.application,
      ...(error.target ? { target: error.target } : {}),
      recovery: error.recovery,
    },
  }
  expect(result.isError).toBe(true)
  expect(result.structuredContent).toEqual(expected)
  expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(expected) }])
  expect(getFin).toHaveBeenCalledTimes(1)
})

test('unexpected exceptions preserve uncertainty and hide host secrets', async () => {
  const create = vi.fn().mockRejectedValue(new Error('secret-host-token'))
  const { client } = await connect({ createVault: create, listVaults: vi.fn(), getFin: vi.fn() })
  const result = await client.callTool({ name: 'create_vault', arguments: { name: 'Home' } })
  expect(result.isError).toBe(true)
  expect(result.structuredContent).toMatchObject({
    error: {
      code: 'OUTCOME_UNKNOWN',
      application: 'unknown',
      recovery: expect.stringContaining('Change Records'),
    },
  })
  expect(JSON.stringify(result)).not.toContain('secret-host-token')
  expect(create).toHaveBeenCalledTimes(1)
})

test('registration performs no access lookup and resolves authorization for each call', async () => {
  const getAccess = vi.fn(async () => ({
    listVaults: async () => [],
    createVault: vi.fn(),
    getFin: vi.fn(),
  }))
  const server = new McpServer({ name: 'shared', version: '0.0.0' })
  registerFinTools(server, createFinTools({ tools: ['vaults.list'] }), { getAccess })
  expect(getAccess).not.toHaveBeenCalled()
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'shared-test', version: '0.0.0' })
  await server.connect(a)
  await client.connect(b)
  disposers.push(
    () => server.close(),
    () => client.close(),
  )
  await Promise.all([
    client.callTool({ name: 'list_vaults', arguments: {} }),
    client.callTool({ name: 'list_vaults', arguments: {} }),
  ])
  expect(getAccess).toHaveBeenCalledTimes(2)
})
