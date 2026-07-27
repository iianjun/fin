import {
  type Account,
  type AccountCreation,
  type AccountMutationResult,
  type AccountUpdate,
  archiveAccount,
  type CreateAccountResult,
  createAccount,
  type DefaultAccountKind,
  initializeVault,
  listAccounts,
  openVault,
  reactivateAccount,
  type SetDefaultAccountResult,
  setDefaultAccount,
  updateAccount,
  type VaultState,
} from '@fin/core'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  accountIdInputSchema,
  accountMutationOutputSchema,
  createAccountInputSchema,
  createAccountOutputSchema,
  initializeVaultInputSchema,
  listAccountsInputSchema,
  listAccountsOutputSchema,
  openVaultInputSchema,
  setDefaultAccountInputSchema,
  setDefaultAccountOutputSchema,
  updateAccountInputSchema,
  vaultStateOutputSchema,
} from './schema.js'

export type VaultOperations = {
  initializeVault: typeof initializeVault
  openVault: typeof openVault
}

export type AccountOperations = {
  archiveAccount: (vaultPath: string, accountId: number) => AccountMutationResult
  createAccount: (vaultPath: string, creation: AccountCreation) => CreateAccountResult
  listAccounts: (vaultPath: string) => Account[]
  reactivateAccount: (vaultPath: string, accountId: number) => AccountMutationResult
  setDefaultAccount: (
    vaultPath: string,
    kind: DefaultAccountKind,
    accountId: number | null,
  ) => SetDefaultAccountResult
  updateAccount: (
    vaultPath: string,
    accountId: number,
    update: AccountUpdate,
  ) => AccountMutationResult
}

export type FinOperations = VaultOperations & AccountOperations

const defaultOperations: FinOperations = {
  archiveAccount,
  createAccount,
  initializeVault,
  listAccounts,
  openVault,
  reactivateAccount,
  setDefaultAccount,
  updateAccount,
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

  server.registerTool(
    'update_account',
    {
      title: 'Update Account',
      description:
        'Rename an Account or change its nature and currency before its first Transaction.',
      inputSchema: updateAccountInputSchema,
      outputSchema: accountMutationOutputSchema,
    },
    ({ path, accountId, name, nature, currency }) =>
      createAccountMutationToolResult(
        operations.updateAccount(path, accountId, { name, nature, currency }),
      ),
  )

  server.registerTool(
    'archive_account',
    {
      title: 'Archive Account',
      description: 'Archive a zero-balance Account that is not configured as a default.',
      inputSchema: accountIdInputSchema,
      outputSchema: accountMutationOutputSchema,
    },
    ({ path, accountId }) =>
      createAccountMutationToolResult(operations.archiveAccount(path, accountId)),
  )

  server.registerTool(
    'reactivate_account',
    {
      title: 'Reactivate Account',
      description: 'Reactivate an archived Account.',
      inputSchema: accountIdInputSchema,
      outputSchema: accountMutationOutputSchema,
    },
    ({ path, accountId }) =>
      createAccountMutationToolResult(operations.reactivateAccount(path, accountId)),
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

function createAccountMutationToolResult(result: AccountMutationResult) {
  let text: string

  if (result.mutation === 'details_updated') {
    text =
      `Updated Account ${result.account.id} from ${formatAccount(result.previousAccount)} ` +
      `to ${formatAccount(result.account)}.`
  } else if (result.mutation === 'archived') {
    text = `Archived ${formatAccount(result.account)}.`
  } else {
    text = `Reactivated ${formatAccount(result.account)}.`
  }

  return {
    content: [{ type: 'text' as const, text }],
    structuredContent: result,
  }
}

function formatAccount(account: Account): string {
  return (
    `${formatNature(account.nature)} Account "${account.name}" ` +
    `(${account.currency}, balance ${account.balanceMinor} minor units, ` +
    `archived: ${account.archived ? 'yes' : 'no'})`
  )
}

function formatNature(nature: Account['nature']): 'Asset' | 'Liability' {
  return nature === 'asset' ? 'Asset' : 'Liability'
}
