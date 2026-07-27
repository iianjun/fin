import { initializeVault, openVault, type VaultState } from '@fin/core'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  initializeVaultInputSchema,
  openVaultInputSchema,
  vaultStateOutputSchema,
} from './schema.js'

export type VaultOperations = {
  initializeVault: typeof initializeVault
  openVault: typeof openVault
}

const defaultVaultOperations: VaultOperations = {
  initializeVault,
  openVault,
}

export function createFinServer(operations: VaultOperations = defaultVaultOperations): McpServer {
  const server = new McpServer({
    name: 'fin',
    version: '0.0.0',
  })

  server.registerTool(
    'initialize_vault',
    {
      title: 'Initialize Vault',
      description: 'Initialize a local folder as a new fin Vault.',
      inputSchema: initializeVaultInputSchema,
      outputSchema: vaultStateOutputSchema,
    },
    ({ path }) => createVaultToolResult('initialized', operations.initializeVault(path)),
  )

  server.registerTool(
    'open_vault',
    {
      title: 'Open Vault',
      description: 'Open an existing fin Vault and apply pending schema migrations.',
      inputSchema: openVaultInputSchema,
      outputSchema: vaultStateOutputSchema,
    },
    ({ path }) => createVaultToolResult('opened', operations.openVault(path)),
  )

  return server
}

function createVaultToolResult(action: 'initialized' | 'opened', state: VaultState) {
  const verb = action === 'initialized' ? 'Initialized' : 'Opened'
  const structuredContent = { action, ...state }

  return {
    content: [
      {
        type: 'text' as const,
        text: `${verb} Vault at ${state.path} with schema version ${state.schemaVersion}, ${state.accountCount} Accounts, and ${state.categoryCount} Categories.`,
      },
    ],
    structuredContent,
  }
}
