import {
  type Account,
  type AccountCreation,
  type CreateAccountResult,
  createAccount,
  type DefaultAccountKind,
  initializeVault,
  listAccounts,
  openVault,
  type SetDefaultAccountResult,
  setDefaultAccount,
  type VaultState,
} from '@fin/core'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  createAccountInputSchema,
  createAccountOutputSchema,
  initializeVaultInputSchema,
  listAccountsInputSchema,
  listAccountsOutputSchema,
  openVaultInputSchema,
  setDefaultAccountInputSchema,
  setDefaultAccountOutputSchema,
  vaultStateOutputSchema,
} from './schema.js'

export type VaultOperations = {
  initializeVault: typeof initializeVault
  openVault: typeof openVault
}

export type AccountOperations = {
  createAccount: (vaultPath: string, creation: AccountCreation) => CreateAccountResult
  listAccounts: (vaultPath: string) => Account[]
  setDefaultAccount: (
    vaultPath: string,
    kind: DefaultAccountKind,
    accountId: number | null,
  ) => SetDefaultAccountResult
}

export type FinOperations = VaultOperations & AccountOperations

const defaultOperations: FinOperations = {
  createAccount,
  initializeVault,
  listAccounts,
  openVault,
  setDefaultAccount,
}

export function createFinServer(operationOverrides: Partial<FinOperations> = {}): McpServer {
  const operations = { ...defaultOperations, ...operationOverrides }
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

  server.registerTool(
    'create_account',
    {
      title: 'Create Account',
      description: 'Create an Asset or Liability Account in a fin Vault.',
      inputSchema: createAccountInputSchema,
      outputSchema: createAccountOutputSchema,
    },
    ({ path, name, nature, currency }) =>
      createAccountToolResult(operations.createAccount(path, { name, nature, currency })),
  )

  server.registerTool(
    'list_accounts',
    {
      title: 'List Accounts',
      description: 'List Accounts with their current balances and archive state.',
      inputSchema: listAccountsInputSchema,
      outputSchema: listAccountsOutputSchema,
    },
    ({ path }) => createListAccountsToolResult(operations.listAccounts(path)),
  )

  server.registerTool(
    'set_default_account',
    {
      title: 'Set Default Account',
      description: 'Select or clear the default Account used for Income or Expense entries.',
      inputSchema: setDefaultAccountInputSchema,
      outputSchema: setDefaultAccountOutputSchema,
    },
    ({ path, kind, accountId }) =>
      createDefaultAccountToolResult(operations.setDefaultAccount(path, kind, accountId)),
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

function createAccountToolResult(result: CreateAccountResult) {
  const { account } = result

  return {
    content: [
      {
        type: 'text' as const,
        text:
          `Created ${formatNature(account.nature)} Account "${account.name}" ` +
          `(ID ${account.id}) in ${account.currency} with balance ` +
          `${account.balanceMinor} minor units; archived: ${account.archived ? 'yes' : 'no'}.`,
      },
    ],
    structuredContent: result,
  }
}

function createListAccountsToolResult(accounts: Account[]) {
  const text =
    accounts.length === 0
      ? 'The Vault has no Accounts.'
      : accounts
          .map(
            (account) =>
              `${account.id}: "${account.name}" — ${formatNature(account.nature)}, ` +
              `${account.currency}, balance ${account.balanceMinor} minor units, ` +
              `archived: ${account.archived ? 'yes' : 'no'}`,
          )
          .join('\n')

  return {
    content: [{ type: 'text' as const, text }],
    structuredContent: { accounts },
  }
}

function createDefaultAccountToolResult(result: SetDefaultAccountResult) {
  const selection = result.selectedAccount
    ? `Set default ${result.kind} Account to "${result.selectedAccount.name}" ` +
      `(ID ${result.selectedAccount.id}, ${formatNature(result.selectedAccount.nature)}, ` +
      `${result.selectedAccount.currency}, archived: ` +
      `${result.selectedAccount.archived ? 'yes' : 'no'}).`
    : `Cleared the default ${result.kind} Account.`
  const defaults =
    `Defaults now: Income ${result.settings.defaultIncomeAccountId ?? 'none'}, ` +
    `Expense ${result.settings.defaultExpenseAccountId ?? 'none'}.`

  return {
    content: [{ type: 'text' as const, text: `${selection} ${defaults}` }],
    structuredContent: result,
  }
}

function formatNature(nature: Account['nature']): 'Asset' | 'Liability' {
  return nature === 'asset' ? 'Asset' : 'Liability'
}
