import {
  type Account,
  type AccountCreation,
  type AccountMutationResult,
  type AccountUpdate,
  type AdjustmentRequest,
  type AdjustmentTransaction,
  type AgentTransactionResult,
  type AppliedTransactionRelation,
  archiveAccount,
  archiveCategory,
  type BalanceQueryResult,
  type Category,
  type CategoryAssignment,
  type CategoryAssignmentInput,
  type CategoryCreation,
  type CategoryMutationResult,
  type CategoryUpdate,
  type CreateAccountResult,
  type CreateCategoryResult,
  createAccount,
  createCategory,
  type DefaultAccountKind,
  type DeleteTransactionResult,
  deleteTransaction,
  type EditTransactionResult,
  editTransaction,
  FinError,
  getIncomeExpenseTransaction,
  getTransactionClassification,
  type IncomeExpenseCreation,
  type IncomeExpenseTransaction,
  initializeVault,
  inspectTransactionRelations,
  isFinError,
  listAccounts,
  listCategories,
  listIncomeExpenseTransactions,
  listTransactionChangeRecords,
  openVault,
  type QueryTransaction,
  queryBalances,
  querySpending,
  queryTransactions,
  type RecordAdjustmentResult,
  type RecordIncomeExpenseResult,
  type RecordRelatedExpenseResult,
  type RecordTransferResult,
  type RecreateTransactionResult,
  type RefundRequest,
  reactivateAccount,
  reactivateCategory,
  recordAdjustment,
  recordAgentTransaction,
  recordIncomeExpense,
  recordRefund,
  recordTransfer,
  recordTransferFee,
  recreateTransaction,
  type SetCategoryAssignmentsResult,
  type SetDefaultAccountResult,
  type SpendingQueryResult,
  setCategoryAssignments,
  setDefaultAccount,
  type TransactionChangeRecord,
  type TransactionClassification,
  type TransactionKind,
  type TransactionQueryResult,
  type TransactionRelationInspection,
  type TransactionReplacement,
  type TransactionSnapshot,
  type TransactionState,
  type TransferFeeRequest,
  type TransferRequest,
  type TransferTransaction,
  updateAccount,
  updateCategory,
  type VaultState,
} from '@fin/core'
import {
  McpServer,
  type RegisteredTool,
  type ToolCallback,
} from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AnySchema, ZodRawShapeCompat } from '@modelcontextprotocol/sdk/server/zod-compat.js'
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import {
  accountIdInputSchema,
  accountMutationOutputSchema,
  categoryIdInputSchema,
  categoryMutationOutputSchema,
  createAccountInputSchema,
  createAccountOutputSchema,
  createCategoryInputSchema,
  createCategoryOutputSchema,
  deleteTransactionInputSchema,
  deleteTransactionOutputSchema,
  editTransactionInputSchema,
  editTransactionOutputSchema,
  finErrorMetadataSchema,
  getIncomeExpenseTransactionInputSchema,
  getIncomeExpenseTransactionOutputSchema,
  getTransactionClassificationInputSchema,
  getTransactionClassificationOutputSchema,
  initializeVaultInputSchema,
  inspectTransactionRelationsInputSchema,
  inspectTransactionRelationsOutputSchema,
  listAccountsInputSchema,
  listAccountsOutputSchema,
  listCategoriesInputSchema,
  listCategoriesOutputSchema,
  listIncomeExpenseTransactionsInputSchema,
  listIncomeExpenseTransactionsOutputSchema,
  listTransactionChangeRecordsInputSchema,
  listTransactionChangeRecordsOutputSchema,
  openVaultInputSchema,
  queryBalancesInputSchema,
  queryBalancesOutputSchema,
  querySpendingInputSchema,
  querySpendingOutputSchema,
  queryTransactionsInputSchema,
  queryTransactionsOutputSchema,
  recordAdjustmentInputSchema,
  recordAdjustmentOutputSchema,
  recordAgentTransactionInputSchema,
  recordAgentTransactionOutputSchema,
  recordIncomeExpenseInputSchema,
  recordIncomeExpenseOutputSchema,
  recordRefundInputSchema,
  recordRelatedExpenseOutputSchema,
  recordTransferFeeInputSchema,
  recordTransferInputSchema,
  recordTransferOutputSchema,
  recreateTransactionInputSchema,
  recreateTransactionOutputSchema,
  setCategoryAssignmentsInputSchema,
  setCategoryAssignmentsOutputSchema,
  setDefaultAccountInputSchema,
  setDefaultAccountOutputSchema,
  updateAccountInputSchema,
  updateCategoryInputSchema,
  vaultStateOutputSchema,
} from './schema.js'
import { FileVaultLocationStore, type VaultLocationStore } from './vault-location.js'

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

export type CategoryOperations = {
  archiveCategory: (vaultPath: string, categoryId: number) => CategoryMutationResult
  createCategory: (vaultPath: string, creation: CategoryCreation) => CreateCategoryResult
  listCategories: (vaultPath: string) => Category[]
  reactivateCategory: (vaultPath: string, categoryId: number) => CategoryMutationResult
  updateCategory: (
    vaultPath: string,
    categoryId: number,
    update: CategoryUpdate,
  ) => CategoryMutationResult
}

export type TransactionOperations = {
  deleteTransaction: typeof deleteTransaction
  editTransaction: typeof editTransaction
  getIncomeExpenseTransaction: (
    vaultPath: string,
    transactionId: number,
  ) => IncomeExpenseTransaction
  inspectTransactionRelations: (
    vaultPath: string,
    transactionId: number,
  ) => TransactionRelationInspection
  getTransactionClassification: (
    vaultPath: string,
    transactionId: number,
  ) => TransactionClassification
  listIncomeExpenseTransactions: (vaultPath: string) => IncomeExpenseTransaction[]
  listTransactionChangeRecords: typeof listTransactionChangeRecords
  recordAdjustment: (vaultPath: string, request: AdjustmentRequest) => RecordAdjustmentResult
  recordIncomeExpense: (
    vaultPath: string,
    creation: IncomeExpenseCreation,
  ) => RecordIncomeExpenseResult
  recordRefund: (vaultPath: string, request: RefundRequest) => RecordRelatedExpenseResult
  recordTransfer: (vaultPath: string, request: TransferRequest) => RecordTransferResult
  recordTransferFee: (vaultPath: string, request: TransferFeeRequest) => RecordRelatedExpenseResult
  recreateTransaction: typeof recreateTransaction
  setCategoryAssignments: (
    vaultPath: string,
    transactionId: number,
    assignments: CategoryAssignmentInput[],
  ) => SetCategoryAssignmentsResult
}

export type QueryOperations = {
  queryBalances: typeof queryBalances
  querySpending: typeof querySpending
  queryTransactions: typeof queryTransactions
}

export type AgentOperations = {
  recordAgentTransaction: typeof recordAgentTransaction
}

export type FinOperations = VaultOperations &
  AccountOperations &
  CategoryOperations &
  TransactionOperations &
  QueryOperations &
  AgentOperations

type ToolConfiguration<
  OutputArgs extends ZodRawShapeCompat | AnySchema,
  InputArgs extends undefined | ZodRawShapeCompat | AnySchema,
> = {
  title?: string
  description?: string
  inputSchema?: InputArgs
  outputSchema?: OutputArgs
  annotations?: ToolAnnotations
  _meta?: Record<string, unknown>
}

class VaultNotConfiguredError extends Error {
  constructor() {
    super('No fin Vault is selected')
    this.name = 'VaultNotConfiguredError'
  }
}

class FinMcpServer extends McpServer {
  #vaultLocationStore: VaultLocationStore | undefined

  useVaultLocationStore(vaultLocationStore: VaultLocationStore): void {
    this.#vaultLocationStore = vaultLocationStore
  }

  override registerTool<
    OutputArgs extends ZodRawShapeCompat | AnySchema,
    InputArgs extends undefined | ZodRawShapeCompat | AnySchema = undefined,
  >(
    name: string,
    config: ToolConfiguration<OutputArgs, InputArgs>,
    callback: ToolCallback<InputArgs>,
  ): RegisteredTool {
    const errorHandlingCallback = (async (...parameters: unknown[]) => {
      const argumentsValue = toToolArguments(parameters[0])

      try {
        return await Reflect.apply(callback, undefined, parameters)
      } catch (error) {
        return validateToolErrorResult(
          createToolErrorResult(name, argumentsValue, error, this.#vaultLocationStore?.get()),
        )
      }
    }) as ToolCallback<InputArgs>

    return super.registerTool(name, config, errorHandlingCallback)
  }
}

const finServerInstructions = [
  'fin remembers one selected Vault across server restarts.',
  'When no Vault is selected, ask the user for a local folder, then call open_vault for an existing Vault or initialize_vault for a new Vault.',
  'Only initialize a Vault after the user confirms that the path is the intended new location.',
  'Never initialize over an existing non-fin database or overwrite an existing fin.sqlite file.',
  'Do not automatically retry integrity or system failures, and do not use initialize_vault to repair them.',
].join(' ')

const defaultOperations: FinOperations = {
  archiveAccount,
  archiveCategory,
  createAccount,
  createCategory,
  deleteTransaction,
  editTransaction,
  getIncomeExpenseTransaction,
  getTransactionClassification,
  initializeVault,
  inspectTransactionRelations,
  listAccounts,
  listCategories,
  listIncomeExpenseTransactions,
  listTransactionChangeRecords,
  openVault,
  queryBalances,
  querySpending,
  queryTransactions,
  reactivateAccount,
  reactivateCategory,
  recordAdjustment,
  recordAgentTransaction,
  recordIncomeExpense,
  recordRefund,
  recordTransfer,
  recordTransferFee,
  recreateTransaction,
  setCategoryAssignments,
  setDefaultAccount,
  updateAccount,
  updateCategory,
}

export function createFinServer(
  operationOverrides: Partial<FinOperations> = {},
  vaultLocationStore: VaultLocationStore = new FileVaultLocationStore(),
): McpServer {
  const operations = { ...defaultOperations, ...operationOverrides }
  const server = new FinMcpServer(
    {
      name: 'fin',
      version: '0.0.0',
    },
    {
      instructions: finServerInstructions,
    },
  )
  server.useVaultLocationStore(vaultLocationStore)
  const vaultPath = (): string => requireVaultPath(vaultLocationStore)

  server.registerTool(
    'initialize_vault',
    {
      title: 'Initialize Vault',
      description: 'Initialize a local folder as a new fin Vault.',
      inputSchema: initializeVaultInputSchema,
      outputSchema: vaultStateOutputSchema,
    },
    ({ path }) => {
      const vault = operations.initializeVault(path)
      vaultLocationStore.save(vault.path)
      return createVaultToolResult('initialized', vault)
    },
  )

  server.registerTool(
    'open_vault',
    {
      title: 'Open Vault',
      description: 'Open an existing fin Vault and apply pending schema migrations.',
      inputSchema: openVaultInputSchema,
      outputSchema: vaultStateOutputSchema,
    },
    ({ path }) => {
      const vault = operations.openVault(path)
      vaultLocationStore.save(vault.path)
      return createVaultToolResult('opened', vault)
    },
  )

  server.registerTool(
    'create_account',
    {
      title: 'Create Account',
      description: 'Create an Asset or Liability Account in a fin Vault.',
      inputSchema: createAccountInputSchema,
      outputSchema: createAccountOutputSchema,
    },
    ({ name, nature, currency }) =>
      createAccountToolResult(operations.createAccount(vaultPath(), { name, nature, currency })),
  )

  server.registerTool(
    'list_accounts',
    {
      title: 'List Accounts',
      description: 'List Accounts with their current balances and archive state.',
      inputSchema: listAccountsInputSchema,
      outputSchema: listAccountsOutputSchema,
    },
    () => createListAccountsToolResult(operations.listAccounts(vaultPath())),
  )

  server.registerTool(
    'set_default_account',
    {
      title: 'Set Default Account',
      description: 'Select or clear the default Account used for Income or Expense entries.',
      inputSchema: setDefaultAccountInputSchema,
      outputSchema: setDefaultAccountOutputSchema,
    },
    ({ kind, accountId }) =>
      createDefaultAccountToolResult(operations.setDefaultAccount(vaultPath(), kind, accountId)),
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
    ({ accountId, name, nature, currency }) =>
      createAccountMutationToolResult(
        operations.updateAccount(vaultPath(), accountId, { name, nature, currency }),
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
    ({ accountId }) =>
      createAccountMutationToolResult(operations.archiveAccount(vaultPath(), accountId)),
  )

  server.registerTool(
    'reactivate_account',
    {
      title: 'Reactivate Account',
      description: 'Reactivate an archived Account.',
      inputSchema: accountIdInputSchema,
      outputSchema: accountMutationOutputSchema,
    },
    ({ accountId }) =>
      createAccountMutationToolResult(operations.reactivateAccount(vaultPath(), accountId)),
  )

  server.registerTool(
    'create_category',
    {
      title: 'Create Category',
      description: 'Create a root or child Category with a path of at most three levels.',
      inputSchema: createCategoryInputSchema,
      outputSchema: createCategoryOutputSchema,
    },
    ({ name, parentId }) =>
      createCategoryToolResult(operations.createCategory(vaultPath(), { name, parentId })),
  )

  server.registerTool(
    'list_categories',
    {
      title: 'List Categories',
      description: 'List Categories with complete current paths and archive state.',
      inputSchema: listCategoriesInputSchema,
      outputSchema: listCategoriesOutputSchema,
    },
    () => createListCategoriesToolResult(operations.listCategories(vaultPath())),
  )

  server.registerTool(
    'update_category',
    {
      title: 'Update Category',
      description: 'Rename or move a Category while preserving a valid three-level hierarchy.',
      inputSchema: updateCategoryInputSchema,
      outputSchema: categoryMutationOutputSchema,
    },
    ({ categoryId, name, parentId }) =>
      createCategoryMutationToolResult(
        operations.updateCategory(vaultPath(), categoryId, { name, parentId }),
      ),
  )

  server.registerTool(
    'archive_category',
    {
      title: 'Archive Category',
      description: 'Archive a Category after its active children are archived.',
      inputSchema: categoryIdInputSchema,
      outputSchema: categoryMutationOutputSchema,
    },
    ({ categoryId }) =>
      createCategoryMutationToolResult(operations.archiveCategory(vaultPath(), categoryId)),
  )

  server.registerTool(
    'reactivate_category',
    {
      title: 'Reactivate Category',
      description: 'Reactivate a Category under an active parent.',
      inputSchema: categoryIdInputSchema,
      outputSchema: categoryMutationOutputSchema,
    },
    ({ categoryId }) =>
      createCategoryMutationToolResult(operations.reactivateCategory(vaultPath(), categoryId)),
  )

  server.registerTool(
    'record_income_expense',
    {
      title: 'Record Income or Expense',
      description:
        'Record positive Income or Expense against one active Account on a calendar date.',
      inputSchema: recordIncomeExpenseInputSchema,
      outputSchema: recordIncomeExpenseOutputSchema,
    },
    ({ kind, accountId, amountMinor, occurredOn, memo }) =>
      createRecordIncomeExpenseToolResult(
        operations.recordIncomeExpense(vaultPath(), {
          kind,
          accountId,
          amountMinor,
          occurredOn,
          memo,
        }),
      ),
  )

  server.registerTool(
    'list_income_expense_transactions',
    {
      title: 'List Income and Expense Transactions',
      description: 'List recorded Income and Expense Transactions with their material values.',
      inputSchema: listIncomeExpenseTransactionsInputSchema,
      outputSchema: listIncomeExpenseTransactionsOutputSchema,
    },
    () => createListIncomeExpenseToolResult(operations.listIncomeExpenseTransactions(vaultPath())),
  )

  server.registerTool(
    'get_income_expense_transaction',
    {
      title: 'Get Income or Expense Transaction',
      description: 'Inspect one Income or Expense Transaction by ID.',
      inputSchema: getIncomeExpenseTransactionInputSchema,
      outputSchema: getIncomeExpenseTransactionOutputSchema,
    },
    ({ transactionId }) =>
      createGetIncomeExpenseToolResult(
        operations.getIncomeExpenseTransaction(vaultPath(), transactionId),
      ),
  )

  server.registerTool(
    'set_category_assignments',
    {
      title: 'Set Category Assignments',
      description:
        'Replace the complete Category Assignment set for an Income or Expense Transaction.',
      inputSchema: setCategoryAssignmentsInputSchema,
      outputSchema: setCategoryAssignmentsOutputSchema,
    },
    ({ transactionId, assignments }) =>
      createSetCategoryAssignmentsToolResult(
        operations.setCategoryAssignments(vaultPath(), transactionId, assignments),
      ),
  )

  server.registerTool(
    'get_transaction_classification',
    {
      title: 'Get Transaction Classification',
      description:
        'Inspect Category Assignments and the signed uncategorized remainder of a Transaction.',
      inputSchema: getTransactionClassificationInputSchema,
      outputSchema: getTransactionClassificationOutputSchema,
    },
    ({ transactionId }) =>
      createTransactionClassificationToolResult(
        operations.getTransactionClassification(vaultPath(), transactionId),
      ),
  )

  server.registerTool(
    'record_adjustment',
    {
      title: 'Record Adjustment',
      description:
        'Apply a signed balance delta or calculate one from a requested target Account balance.',
      inputSchema: recordAdjustmentInputSchema,
      outputSchema: recordAdjustmentOutputSchema,
    },
    ({ accountId, occurredOn, amountMinor, targetBalanceMinor, memo }) =>
      createRecordAdjustmentToolResult(
        operations.recordAdjustment(vaultPath(), {
          accountId,
          occurredOn,
          amountMinor,
          targetBalanceMinor,
          memo,
        }),
      ),
  )

  server.registerTool(
    'record_transfer',
    {
      title: 'Record Transfer',
      description:
        'Move value between two active Accounts using actual source and destination amounts.',
      inputSchema: recordTransferInputSchema,
      outputSchema: recordTransferOutputSchema,
    },
    ({
      sourceAccountId,
      sourceAmountMinor,
      destinationAccountId,
      destinationAmountMinor,
      occurredOn,
      memo,
    }) =>
      createRecordTransferToolResult(
        operations.recordTransfer(vaultPath(), {
          sourceAccountId,
          sourceAmountMinor,
          destinationAccountId,
          destinationAmountMinor,
          occurredOn,
          memo,
        }),
      ),
  )

  server.registerTool(
    'record_refund',
    {
      title: 'Record Refund',
      description:
        'Record a Refund as a negative Expense, optionally related to its original positive Expense.',
      inputSchema: recordRefundInputSchema,
      outputSchema: recordRelatedExpenseOutputSchema,
    },
    ({ accountId, amountMinor, occurredOn, memo, originalExpenseId }) =>
      createRecordRefundToolResult(
        operations.recordRefund(vaultPath(), {
          accountId,
          amountMinor,
          occurredOn,
          memo,
          originalExpenseId,
        }),
      ),
  )

  server.registerTool(
    'record_transfer_fee',
    {
      title: 'Record Transfer Fee',
      description: 'Record a positive Expense related to an existing Transfer.',
      inputSchema: recordTransferFeeInputSchema,
      outputSchema: recordRelatedExpenseOutputSchema,
    },
    ({ accountId, amountMinor, occurredOn, memo, transferId }) =>
      createRecordTransferFeeToolResult(
        operations.recordTransferFee(vaultPath(), {
          accountId,
          amountMinor,
          occurredOn,
          memo,
          transferId,
        }),
      ),
  )

  server.registerTool(
    'inspect_transaction_relations',
    {
      title: 'Inspect Transaction Relations',
      description:
        'Find related Refunds, original Expenses, Transfer fees, and Transfers before changing more than one Transaction.',
      inputSchema: inspectTransactionRelationsInputSchema,
      outputSchema: inspectTransactionRelationsOutputSchema,
    },
    ({ transactionId }) =>
      createTransactionRelationInspectionToolResult(
        operations.inspectTransactionRelations(vaultPath(), transactionId),
      ),
  )

  server.registerTool(
    'edit_transaction',
    {
      title: 'Edit Transaction',
      description:
        'Replace the material values of one Transaction while preserving its identity and invariants.',
      inputSchema: editTransactionInputSchema,
      outputSchema: editTransactionOutputSchema,
    },
    ({
      transactionId,
      kind,
      occurredOn,
      memo,
      accountId,
      amountMinor,
      sourceAccountId,
      sourceAmountMinor,
      destinationAccountId,
      destinationAmountMinor,
      assignments,
      relation,
    }) =>
      createEditTransactionToolResult(
        operations.editTransaction(vaultPath(), {
          transactionId,
          replacement: createTransactionReplacement({
            kind,
            occurredOn,
            memo,
            accountId,
            amountMinor,
            sourceAccountId,
            sourceAmountMinor,
            destinationAccountId,
            destinationAmountMinor,
            assignments,
            relation,
          }),
        }),
      ),
  )

  server.registerTool(
    'delete_transaction',
    {
      title: 'Delete Transaction',
      description: 'Delete one active Transaction after related Transactions have been inspected.',
      inputSchema: deleteTransactionInputSchema,
      outputSchema: deleteTransactionOutputSchema,
    },
    ({ transactionId }) =>
      createDeleteTransactionToolResult(operations.deleteTransaction(vaultPath(), transactionId)),
  )

  server.registerTool(
    'list_transaction_change_records',
    {
      title: 'List Transaction Change Records',
      description:
        'List immutable structured Transaction history with complete natural-language descriptions.',
      inputSchema: listTransactionChangeRecordsInputSchema,
      outputSchema: listTransactionChangeRecordsOutputSchema,
    },
    ({ transactionId }) =>
      createListTransactionChangeRecordsToolResult(
        operations.listTransactionChangeRecords(vaultPath(), transactionId),
      ),
  )

  server.registerTool(
    'recreate_transaction',
    {
      title: 'Recreate Transaction',
      description: 'Create a new Transaction identity from a deleted Transaction Change Record.',
      inputSchema: recreateTransactionInputSchema,
      outputSchema: recreateTransactionOutputSchema,
    },
    ({ deletionChangeRecordId }) =>
      createRecreateTransactionToolResult(
        operations.recreateTransaction(vaultPath(), deletionChangeRecordId),
      ),
  )

  server.registerTool(
    'query_balances',
    {
      title: 'Query Balances',
      description:
        'Inspect every Account balance and archive state with net worth kept separate by currency.',
      inputSchema: queryBalancesInputSchema,
      outputSchema: queryBalancesOutputSchema,
    },
    () => createQueryBalancesToolResult(operations.queryBalances(vaultPath())),
  )

  server.registerTool(
    'query_transactions',
    {
      title: 'Query Transactions',
      description:
        'Filter Transactions by date, Account, kind, and memo with currency-separated Income and Expense totals.',
      inputSchema: queryTransactionsInputSchema,
      outputSchema: queryTransactionsOutputSchema,
    },
    ({ dateFrom, dateTo, accountId, kinds, memoContains }) =>
      createQueryTransactionsToolResult(
        operations.queryTransactions(vaultPath(), {
          dateFrom,
          dateTo,
          accountId,
          kinds,
          memoContains,
        }),
      ),
  )

  server.registerTool(
    'query_spending',
    {
      title: 'Query Spending',
      description:
        'Query net Expense, current Category rollups, uncategorized amounts, and memo evidence by currency.',
      inputSchema: querySpendingInputSchema,
      outputSchema: querySpendingOutputSchema,
    },
    ({ dateFrom, dateTo, accountId, memoContains, categoryId }) =>
      createQuerySpendingToolResult(
        operations.querySpending(vaultPath(), {
          dateFrom,
          dateTo,
          accountId,
          memoContains,
          categoryId,
        }),
      ),
  )

  server.registerTool(
    'record_agent_transaction',
    {
      title: 'Record Agent Transaction Safely',
      description:
        'Resolve defaults and unique matches, return candidates or confirmations without mutation when unsafe, and record detailed Income or Expense receipts.',
      inputSchema: recordAgentTransactionInputSchema,
      outputSchema: recordAgentTransactionOutputSchema,
    },
    ({
      kind,
      accountId,
      accountName,
      amountMinor,
      occurredOn,
      memo,
      categoryId,
      categoryQuery,
      categoryAmountMinor,
      proposedCategory,
      confirmNewCategory,
      confirmDuplicate,
    }) =>
      createAgentTransactionToolResult(
        operations.recordAgentTransaction(vaultPath(), {
          kind,
          accountId,
          accountName,
          amountMinor,
          occurredOn,
          memo,
          categoryId,
          categoryQuery,
          categoryAmountMinor,
          proposedCategory,
          confirmNewCategory,
          confirmDuplicate,
        }),
      ),
  )

  return server
}

function createToolErrorResult(
  toolName: string,
  toolArguments: Record<string, unknown>,
  error: unknown,
  configuredVaultPath: string | undefined,
): CallToolResult {
  if (error instanceof VaultNotConfiguredError) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text:
            'No fin Vault is selected. Ask the user for a local folder, then call open_vault ' +
            'for an existing Vault or initialize_vault for a new Vault before retrying this tool.',
        },
      ],
      _meta: {
        'fin/error': {
          code: 'VAULT_NOT_CONFIGURED',
          retryable: true,
        },
      },
    }
  }

  if (isFinError(error)) {
    return createKnownToolErrorResult(toolName, toolArguments, error, configuredVaultPath)
  }

  const path = readString(toolArguments.path) ?? configuredVaultPath
  const location = path === undefined ? 'the requested location' : `the Vault path ${path}`

  return {
    isError: true,
    content: [
      {
        type: 'text',
        text:
          `fin could not safely access ${location}. ` +
          'Verify the path and its permissions with the user. Do not retry or call ' +
          'initialize_vault until the location has been verified.',
      },
    ],
    _meta: {
      'fin/error': {
        code: 'SYSTEM_FAILURE',
        retryable: false,
      },
    },
  }
}

function validateToolErrorResult(result: CallToolResult): CallToolResult {
  finErrorMetadataSchema.parse(result._meta?.['fin/error'])
  return result
}

function createKnownToolErrorResult(
  toolName: string,
  toolArguments: Record<string, unknown>,
  error: FinError,
  configuredVaultPath: string | undefined,
): CallToolResult {
  const path =
    readString(error.details.path) ?? readString(toolArguments.path) ?? configuredVaultPath
  const databasePath = readString(error.details.databasePath)

  if (error.code === 'VAULT_NOT_FOUND' && path !== undefined) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text:
            `No fin Vault exists at ${path}. ` +
            `Call initialize_vault with the same path before retrying ${toolName}.`,
        },
      ],
      _meta: {
        'fin/error': {
          code: error.code,
          retryable: true,
          recovery: {
            tool: 'initialize_vault',
            arguments: { path },
          },
          retry: {
            tool: toolName,
            arguments: toolArguments,
          },
        },
      },
    }
  }

  if (error.code === 'VAULT_ALREADY_EXISTS' && path !== undefined) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text:
            `A fin Vault already exists at ${path}. ` +
            'Call open_vault with the same path instead of initializing it again.',
        },
      ],
      _meta: {
        'fin/error': {
          code: error.code,
          retryable: true,
          recovery: {
            tool: 'open_vault',
            arguments: { path },
          },
        },
      },
    }
  }

  if (
    error.code === 'INTEGRITY_FAILURE' &&
    error.details.reason === 'not_fin_vault' &&
    databasePath !== undefined
  ) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text:
            `The database at ${databasePath} is not a valid fin Vault. ` +
            'Do not call initialize_vault, overwrite the database, or retry this tool. ' +
            'Ask the user to inspect the existing database or choose a different path.',
        },
      ],
      _meta: {
        'fin/error': {
          code: error.code,
          retryable: false,
        },
      },
    }
  }

  if (error.code === 'INTEGRITY_FAILURE' && path !== undefined) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text:
            `The fin Vault at ${path} has an invalid internal state. ` +
            'Do not retry or call initialize_vault. Ask the user to inspect the Vault and ' +
            'report the problem.',
        },
      ],
      _meta: {
        'fin/error': {
          code: error.code,
          retryable: false,
        },
      },
    }
  }

  if (error.code === 'ENTITY_NOT_FOUND' && path !== undefined) {
    const recovery = readEntityRecovery(error.details.entityType)

    if (recovery !== undefined) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text:
              `${error.message}. Call ${recovery.tool} to inspect valid ${recovery.label} IDs ` +
              `in the selected Vault before retrying ${toolName}.`,
          },
        ],
        _meta: {
          'fin/error': {
            code: error.code,
            retryable: true,
            recovery: {
              tool: recovery.tool,
              arguments: {},
            },
            retry: {
              tool: toolName,
              arguments: toolArguments,
            },
          },
        },
      }
    }
  }

  if (error.code === 'ENTITY_ARCHIVED' && path !== undefined) {
    const recovery = readArchivedEntityRecovery(error.details.entityType, error.details.entityId)

    if (recovery !== undefined) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text:
              `${error.message}. Call ${recovery.listTool} to choose an active ` +
              `${recovery.label} in the selected Vault. Only call ${recovery.reactivateTool} for ` +
              `${recovery.label} ${recovery.entityId} after the user confirms reactivation, ` +
              `then retry ${toolName}.`,
          },
        ],
        _meta: {
          'fin/error': {
            code: error.code,
            retryable: true,
            recovery: {
              tool: recovery.listTool,
              arguments: {},
            },
            alternative: {
              tool: recovery.reactivateTool,
              arguments: recovery.reactivateArguments,
              requiresConfirmation: true,
            },
            retry: {
              tool: toolName,
              arguments: toolArguments,
            },
          },
        },
      }
    }
  }

  if (
    error.code === 'PREREQUISITE_REQUIRED' &&
    error.details.prerequisite === 'clear_default_accounts' &&
    path !== undefined
  ) {
    const entityId = readPositiveInteger(error.details.entityId)
    const entityName = readString(error.details.entityName)
    const defaultKinds = readDefaultAccountKinds(error.details.defaultKinds)

    if (entityId !== undefined && entityName !== undefined && defaultKinds.length > 0) {
      const steps = defaultKinds.map((kind) => ({
        tool: 'set_default_account',
        arguments: {
          kind,
          accountId: null,
        },
      }))
      const defaultLabel = defaultKinds.map(capitalize).join(' and ')
      const instructions = steps
        .map(
          (step) =>
            `Call ${step.tool} with kind "${String(step.arguments.kind)}" and accountId null`,
        )
        .join(', then ')

      return {
        isError: true,
        content: [
          {
            type: 'text',
            text:
              `Account ${entityId} ("${entityName}") is configured as the default ` +
              `${defaultLabel} Account. ${instructions}, then retry ${toolName}.`,
          },
        ],
        _meta: {
          'fin/error': {
            code: error.code,
            retryable: true,
            recovery: { steps },
            retry: {
              tool: toolName,
              arguments: toolArguments,
            },
          },
        },
      }
    }
  }

  if (error.code === 'INVALID_INPUT') {
    const fields = readStringArray(error.details.fields)

    if (fields.length > 0) {
      const fieldLabel = fields.length === 1 ? `${fields[0]} field` : `${fields.join(', ')} fields`

      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `${error.message}. Correct the ${fieldLabel} before retrying ${toolName}.`,
          },
        ],
        _meta: {
          'fin/error': {
            code: error.code,
            retryable: true,
            recovery: {
              action: 'correct_arguments',
              fields,
            },
          },
        },
      }
    }
  }

  return {
    isError: true,
    content: [
      {
        type: 'text',
        text:
          'fin detected an invalid or unsafe Vault state. Do not retry or call initialize_vault. ' +
          'Ask the user to inspect the Vault and report the problem.',
      },
    ],
    _meta: {
      'fin/error': {
        code: error.code,
        retryable: false,
      },
    },
  }
}

function toToolArguments(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return { ...value }
  }

  return {}
}

function requireVaultPath(vaultLocationStore: VaultLocationStore): string {
  const path = vaultLocationStore.get()

  if (path === undefined) {
    throw new VaultNotConfiguredError()
  }

  return path
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function readPositiveInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : undefined
}

function readDefaultAccountKinds(value: unknown): Array<'income' | 'expense'> {
  if (!Array.isArray(value)) {
    return []
  }

  return value.filter(
    (kind): kind is 'income' | 'expense' => kind === 'income' || kind === 'expense',
  )
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function readEntityRecovery(entityType: unknown): { tool: string; label: string } | undefined {
  if (entityType === 'account') {
    return { tool: 'list_accounts', label: 'Account' }
  }

  if (entityType === 'category') {
    return { tool: 'list_categories', label: 'Category' }
  }

  if (entityType === 'income_expense_transaction') {
    return {
      tool: 'list_income_expense_transactions',
      label: 'Income or Expense Transaction',
    }
  }

  if (entityType === 'transaction') {
    return { tool: 'query_transactions', label: 'Transaction' }
  }

  return undefined
}

function readArchivedEntityRecovery(
  entityType: unknown,
  entityId: unknown,
):
  | {
      listTool: string
      reactivateTool: string
      reactivateArguments: Record<string, unknown>
      label: string
      entityId: number
    }
  | undefined {
  if (!Number.isSafeInteger(entityId) || (entityId as number) <= 0) {
    return undefined
  }

  if (entityType === 'account') {
    return {
      listTool: 'list_accounts',
      reactivateTool: 'reactivate_account',
      reactivateArguments: { accountId: entityId },
      label: 'Account',
      entityId: entityId as number,
    }
  }

  if (entityType === 'category') {
    return {
      listTool: 'list_categories',
      reactivateTool: 'reactivate_category',
      reactivateArguments: { categoryId: entityId },
      label: 'Category',
      entityId: entityId as number,
    }
  }

  return undefined
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

function createCategoryToolResult(result: CreateCategoryResult) {
  return {
    content: [
      {
        type: 'text' as const,
        text: `Created ${formatCategory(result.category)}.`,
      },
    ],
    structuredContent: result,
  }
}

function createListCategoriesToolResult(categories: Category[]) {
  const text =
    categories.length === 0
      ? 'The Vault has no Categories.'
      : categories.map((category) => `${category.id}: ${formatCategory(category)}`).join('\n')

  return {
    content: [{ type: 'text' as const, text }],
    structuredContent: { categories },
  }
}

function createCategoryMutationToolResult(result: CategoryMutationResult) {
  let text: string

  if (result.mutation === 'details_updated') {
    text =
      `Updated Category ${result.category.id} from "${result.previousCategory.path}" ` +
      `to ${formatCategory(result.category)}.`
  } else if (result.mutation === 'archived') {
    text = `Archived ${formatCategory(result.category)}.`
  } else {
    text = `Reactivated ${formatCategory(result.category)}.`
  }

  return {
    content: [{ type: 'text' as const, text }],
    structuredContent: result,
  }
}

function createRecordIncomeExpenseToolResult(result: RecordIncomeExpenseResult) {
  return {
    content: [
      {
        type: 'text' as const,
        text:
          `Recorded ${formatIncomeExpenseTransaction(result.transaction)}. ` +
          `Account balance changed from ${result.previousBalanceMinor} to ` +
          `${result.resultingBalanceMinor} minor units.`,
      },
    ],
    structuredContent: result,
  }
}

function createListIncomeExpenseToolResult(transactions: IncomeExpenseTransaction[]) {
  const text =
    transactions.length === 0
      ? 'The Vault has no Income or Expense Transactions.'
      : transactions.map(formatIncomeExpenseTransaction).join('\n')

  return {
    content: [{ type: 'text' as const, text }],
    structuredContent: { transactions },
  }
}

function createGetIncomeExpenseToolResult(transaction: IncomeExpenseTransaction) {
  return {
    content: [{ type: 'text' as const, text: formatIncomeExpenseTransaction(transaction) }],
    structuredContent: { transaction },
  }
}

function createSetCategoryAssignmentsToolResult(result: SetCategoryAssignmentsResult) {
  return {
    content: [{ type: 'text' as const, text: formatTransactionClassification(result) }],
    structuredContent: result,
  }
}

function createTransactionClassificationToolResult(result: TransactionClassification) {
  return {
    content: [{ type: 'text' as const, text: formatTransactionClassification(result) }],
    structuredContent: result,
  }
}

function createRecordAdjustmentToolResult(result: RecordAdjustmentResult) {
  const target =
    result.requestedTargetBalanceMinor === null
      ? 'Direct signed Adjustment.'
      : `Requested target balance: ${result.requestedTargetBalanceMinor} ` +
        `${result.transaction.account.currency}.`

  return {
    content: [
      {
        type: 'text' as const,
        text:
          `${formatAdjustmentTransaction(result.transaction)}. ${target} ` +
          `Balance: ${result.previousBalanceMinor} + (${result.adjustmentAmountMinor}) = ` +
          `${result.resultingBalanceMinor} minor units.`,
      },
    ],
    structuredContent: result,
  }
}

function createRecordTransferToolResult(result: RecordTransferResult) {
  return {
    content: [
      {
        type: 'text' as const,
        text:
          `${formatTransferTransaction(result.transaction)}. ` +
          `Source balance: ${result.sourcePreviousBalanceMinor} to ` +
          `${result.sourceResultingBalanceMinor}; destination balance: ` +
          `${result.destinationPreviousBalanceMinor} to ` +
          `${result.destinationResultingBalanceMinor} minor units.`,
      },
    ],
    structuredContent: result,
  }
}

function createRecordRefundToolResult(result: RecordRelatedExpenseResult) {
  const relation =
    result.relation === null
      ? 'The Refund is intentionally unlinked.'
      : `Related to original Expense Transaction ${result.relation.targetTransactionId}.`

  return {
    content: [
      {
        type: 'text' as const,
        text:
          `Recorded Refund as ${formatIncomeExpenseTransaction(result.transaction)}. ` +
          `${relation} Account balance changed from ${result.previousBalanceMinor} to ` +
          `${result.resultingBalanceMinor} minor units.`,
      },
    ],
    structuredContent: result,
  }
}

function createRecordTransferFeeToolResult(result: RecordRelatedExpenseResult) {
  const transferId = result.relation?.targetTransactionId

  return {
    content: [
      {
        type: 'text' as const,
        text:
          `Recorded Transfer fee as ${formatIncomeExpenseTransaction(result.transaction)}. ` +
          `Related to Transfer Transaction ${transferId}. ` +
          `Account balance changed from ${result.previousBalanceMinor} to ` +
          `${result.resultingBalanceMinor} minor units.`,
      },
    ],
    structuredContent: result,
  }
}

function createTransactionRelationInspectionToolResult(result: TransactionRelationInspection) {
  const related =
    result.relatedTransactions.length === 0
      ? 'No related Transactions.'
      : result.relatedTransactions
          .map(
            ({ direction, relationKind, transaction }) =>
              `${direction} ${relationKind}: ${formatTransactionSnapshot(transaction)}`,
          )
          .join('\n')
  const confirmation = result.requiresConfirmationBeforeMultiTransactionChange
    ? 'Explicit confirmation is required before changing multiple related Transactions.'
    : 'No multi-Transaction confirmation is required.'

  return {
    content: [
      {
        type: 'text' as const,
        text: `${formatTransactionSnapshot(result.transaction)}\n${related}\n${confirmation}`,
      },
    ],
    structuredContent: result,
  }
}

type TransactionReplacementToolInput = {
  kind: TransactionKind
  occurredOn: string
  memo: string | null | undefined
  accountId: number | undefined
  amountMinor: number | undefined
  sourceAccountId: number | undefined
  sourceAmountMinor: number | undefined
  destinationAccountId: number | undefined
  destinationAmountMinor: number | undefined
  assignments: CategoryAssignmentInput[] | undefined
  relation: AppliedTransactionRelation | null | undefined
}

function createTransactionReplacement(
  input: TransactionReplacementToolInput,
): TransactionReplacement {
  if (input.kind === 'transfer') {
    return {
      kind: 'transfer',
      sourceAccountId: requireToolNumber(input.sourceAccountId, 'sourceAccountId'),
      sourceAmountMinor: requireToolNumber(input.sourceAmountMinor, 'sourceAmountMinor'),
      destinationAccountId: requireToolNumber(input.destinationAccountId, 'destinationAccountId'),
      destinationAmountMinor: requireToolNumber(
        input.destinationAmountMinor,
        'destinationAmountMinor',
      ),
      occurredOn: input.occurredOn,
      memo: input.memo,
    }
  }

  const accountId = requireToolNumber(input.accountId, 'accountId')
  const amountMinor = requireToolNumber(input.amountMinor, 'amountMinor')

  if (input.kind === 'adjustment') {
    return {
      kind: 'adjustment',
      accountId,
      amountMinor,
      occurredOn: input.occurredOn,
      memo: input.memo,
    }
  }

  return {
    kind: input.kind,
    accountId,
    amountMinor,
    occurredOn: input.occurredOn,
    memo: input.memo,
    assignments: input.assignments,
    relation: input.relation,
  }
}

function createEditTransactionToolResult(result: EditTransactionResult) {
  return {
    content: [
      {
        type: 'text' as const,
        text:
          `Edited ${formatLifecycleTransaction(result.previousTransaction)} to ` +
          `${formatLifecycleTransaction(result.transaction)}. ` +
          `${formatLifecycleBalances(result.balanceChanges)} ` +
          `${formatRelatedTransactionNotice(
            result.relatedTransactions.length,
            result.requiresConfirmationBeforeMultiTransactionChange,
          )}`,
      },
    ],
    structuredContent: result,
  }
}

function createDeleteTransactionToolResult(result: DeleteTransactionResult) {
  return {
    content: [
      {
        type: 'text' as const,
        text:
          `Deleted ${formatLifecycleTransaction(result.transaction)}. ` +
          `${formatLifecycleBalances(result.balanceChanges)} ` +
          `${formatRelatedTransactionNotice(
            result.relatedTransactions.length,
            result.requiresConfirmationBeforeMultiTransactionChange,
          )}`,
      },
    ],
    structuredContent: result,
  }
}

function createListTransactionChangeRecordsToolResult(changeRecords: TransactionChangeRecord[]) {
  return {
    content: [
      {
        type: 'text' as const,
        text:
          changeRecords.length === 0
            ? 'No Transaction Change Records found.'
            : changeRecords
                .map(
                  (record) =>
                    `Change Record ${record.id} at ${record.recordedAt}: ${record.description}`,
                )
                .join('\n'),
      },
    ],
    structuredContent: { changeRecords },
  }
}

function createRecreateTransactionToolResult(result: RecreateTransactionResult) {
  const omitted =
    result.omittedIncomingRelations.length === 0
      ? 'No incoming relations were omitted.'
      : `${result.omittedIncomingRelations.length} incoming relation(s) were not reattached ` +
        'because related Transactions are never changed implicitly.'

  return {
    content: [
      {
        type: 'text' as const,
        text:
          `Recreated deleted Transaction ${result.deletedTransactionId} as ` +
          `${formatLifecycleTransaction(result.transaction)} from Change Record ` +
          `${result.recreatedFromChangeRecordId}. ` +
          `${formatLifecycleBalances(result.balanceChanges)} ${omitted}`,
      },
    ],
    structuredContent: result,
  }
}

function createQueryBalancesToolResult(result: BalanceQueryResult) {
  const accounts =
    result.accounts.length === 0
      ? 'No Accounts.'
      : result.accounts
          .map((account) => `Account ${account.id}: ${formatAccount(account)}`)
          .join('\n')
  const netWorth =
    result.netWorthByCurrency.length === 0
      ? 'Net worth: no currencies.'
      : `Net worth: ${result.netWorthByCurrency
          .map((total) => `${total.amountMinor} ${total.currency}`)
          .join('; ')}.`

  return {
    content: [{ type: 'text' as const, text: `${accounts}\n${netWorth}` }],
    structuredContent: result,
  }
}

function createQueryTransactionsToolResult(result: TransactionQueryResult) {
  const transactions =
    result.transactions.length === 0
      ? 'No matching Transactions.'
      : result.transactions.map(formatQueryTransaction).join('\n')
  const totals =
    result.incomeExpenseTotalsByCurrency.length === 0
      ? 'Income and Expense totals: none.'
      : `Income and Expense totals: ${result.incomeExpenseTotalsByCurrency
          .map(
            (total) =>
              `${total.currency} Income ${total.incomeMinor}, Expense ${total.expenseMinor}, ` +
              `net Income ${total.netIncomeMinor}; evidence Transactions ` +
              `${total.transactionIds.join(', ')}`,
          )
          .join('\n')}`

  return {
    content: [
      {
        type: 'text' as const,
        text: `Matched ${result.transactions.length} Transaction(s).\n${transactions}\n${totals}`,
      },
    ],
    structuredContent: result,
  }
}

function createQuerySpendingToolResult(result: SpendingQueryResult) {
  const expenseTotals =
    result.expenseTotalsByCurrency.length === 0
      ? 'Expense totals: none.'
      : `Expense totals: ${formatCurrencyAmounts(result.expenseTotalsByCurrency)}.`
  const uncategorized =
    result.uncategorizedByCurrency.length === 0
      ? 'Uncategorized: none.'
      : `Uncategorized: ${formatCurrencyAmounts(result.uncategorizedByCurrency)}.`
  const rollups =
    result.categoryRollups.length === 0
      ? 'Category rollups: none.'
      : `Category rollups:\n${result.categoryRollups
          .map(
            (rollup) =>
              `Category "${rollup.categoryPath}" (ID ${rollup.categoryId}): ` +
              `${rollup.amountMinor} ${rollup.currency}; evidence Transactions ` +
              `${rollup.transactionIds.join(', ')}`,
          )
          .join('\n')}`
  const evidence =
    result.transactions.length === 0
      ? 'No matching Expense evidence.'
      : result.transactions.map(formatQueryTransaction).join('\n')

  return {
    content: [
      {
        type: 'text' as const,
        text:
          `Matched ${result.transactions.length} Expense Transaction(s).\n` +
          `${expenseTotals}\n${uncategorized}\n${rollups}\n${evidence}`,
      },
    ],
    structuredContent: result,
  }
}

function createAgentTransactionToolResult(result: AgentTransactionResult) {
  if (result.receipt !== null) {
    const { applied, transaction } = result.receipt
    const category =
      applied.category.value === null
        ? `uncategorized (${applied.category.source})`
        : `Category "${applied.category.value.path}" ` +
          `(ID ${applied.category.value.id}, ${applied.category.source}), assigned ` +
          `${String(applied.categoryAmountMinor.value)} minor units ` +
          `(${applied.categoryAmountMinor.source})`
    const duplicate =
      result.receipt.duplicateConfirmation === 'confirmed'
        ? `Confirmed legitimate duplicate after matching Transaction(s) ` +
          `${result.duplicateMatches.map((match) => match.transactionId).join(', ')}.`
        : 'No likely duplicate required confirmation.'

    return {
      content: [
        {
          type: 'text' as const,
          text:
            `Recorded ${capitalize(transaction.kind)} Transaction ${transaction.id}: ` +
            `Account "${transaction.account.name}" (ID ${transaction.account.id}, ` +
            `${transaction.account.currency}, ${applied.account.source}); ` +
            `${transaction.amountMinor} minor units (${applied.amountMinor.source}); ` +
            `date ${transaction.occurredOn} (${applied.occurredOn.source}); ` +
            `${transaction.memo === null ? 'no memo' : `memo "${transaction.memo}"`} ` +
            `(${applied.memo.source}); ${category}; uncategorized ` +
            `${result.receipt.uncategorizedAmountMinor} minor units. ` +
            `Account balance changed from ${result.receipt.previousBalanceMinor} to ` +
            `${result.receipt.resultingBalanceMinor}. ${duplicate}`,
        },
      ],
      structuredContent: result,
    }
  }

  const kindCandidates =
    result.candidates.transactionKinds.length === 0
      ? ''
      : `\nTransaction kind candidates: ${result.candidates.transactionKinds
          .map((candidate) => candidate.label)
          .join(', ')}.`
  const accountCandidates =
    result.candidates.accounts.length === 0
      ? ''
      : `\nAccount candidates: ${result.candidates.accounts
          .map(
            (account) =>
              `"${account.name}" (ID ${account.id}, ${account.nature}, ` +
              `${account.currency}, balance ${account.balanceMinor}, ` +
              `archived: ${account.archived ? 'yes' : 'no'})`,
          )
          .join('; ')}.`
  const categoryCandidates =
    result.candidates.categories.length === 0
      ? ''
      : `\nCategory candidates: ${result.candidates.categories
          .map((category) => `"${category.path}" (ID ${category.id})`)
          .join('; ')}.`
  const duplicates =
    result.duplicateMatches.length === 0
      ? ''
      : `\nLikely duplicates: ${result.duplicateMatches
          .map(
            (match) =>
              `${capitalize(match.kind)} Transaction ${match.transactionId}, ` +
              `Account "${match.account.name}" (ID ${match.account.id}), ` +
              `${match.amountMinor} ${match.account.currency} on ${match.occurredOn}, ` +
              `${match.memo === null ? 'no memo' : `memo "${match.memo}"`}`,
          )
          .join('; ')}.`
  const proposal =
    result.proposedCategory === null
      ? ''
      : `\nProposed Category: "${result.proposedCategory.name}" under parent ` +
        `${result.proposedCategory.parentId ?? 'none'}.`

  return {
    content: [
      {
        type: 'text' as const,
        text:
          `${result.message}${kindCandidates}${accountCandidates}${categoryCandidates}` +
          `${duplicates}${proposal}\nNo Vault mutation was applied.`,
      },
    ],
    structuredContent: result,
  }
}

function formatQueryTransaction(transaction: QueryTransaction): string {
  const memo = transaction.memo === null ? 'no memo' : `memo "${transaction.memo}"`
  const relations =
    transaction.relations.length === 0
      ? 'no relations'
      : transaction.relations
          .map(
            (relation) =>
              `${relation.direction} ${relation.relationKind} Transaction ` +
              `${relation.relatedTransactionId}`,
          )
          .join(', ')

  if (transaction.kind === 'transfer') {
    return (
      `Transfer Transaction ${transaction.id} on ${transaction.occurredOn}, ${memo}: ` +
      `Account "${transaction.source.account.name}" (ID ${transaction.source.account.id}) ` +
      `sends ${transaction.source.amountMinor} ${transaction.source.account.currency}; ` +
      `Account "${transaction.destination.account.name}" ` +
      `(ID ${transaction.destination.account.id}) receives ` +
      `${transaction.destination.amountMinor} ` +
      `${transaction.destination.account.currency}; ${relations}`
    )
  }

  const base =
    `${capitalize(transaction.kind)} Transaction ${transaction.id} on ` +
    `${transaction.occurredOn}, ${memo}: Account "${transaction.account.name}" ` +
    `(ID ${transaction.account.id}), ${transaction.amountMinor} ` +
    `${transaction.account.currency}`

  if (transaction.kind === 'adjustment') {
    return `${base}; ${relations}`
  }

  const assignments =
    transaction.assignments.length === 0
      ? 'no Category Assignments'
      : transaction.assignments
          .map(
            (assignment) =>
              `${assignment.origin} Category "${assignment.categoryPath}" ` +
              `${assignment.amountMinor} ${assignment.currency}`,
          )
          .join(', ')

  return (
    `${base}; ${assignments}; uncategorized ` +
    `${transaction.uncategorizedAmountMinor} ${transaction.account.currency}; ${relations}`
  )
}

function formatCurrencyAmounts(amounts: Array<{ currency: string; amountMinor: number }>): string {
  return amounts.map((amount) => `${amount.amountMinor} ${amount.currency}`).join('; ')
}

function formatLifecycleTransaction(transaction: TransactionState): string {
  const memo = transaction.memo === null ? 'no memo' : `memo "${transaction.memo}"`

  if (transaction.kind === 'transfer') {
    return (
      `Transfer Transaction ${transaction.id} on ${transaction.occurredOn}, ${memo}: ` +
      `source Account "${transaction.source.account.name}" ` +
      `(ID ${transaction.source.account.id}) sends ${transaction.source.amountMinor} ` +
      `${transaction.source.account.currency}; destination Account ` +
      `"${transaction.destination.account.name}" ` +
      `(ID ${transaction.destination.account.id}) receives ` +
      `${transaction.destination.amountMinor} ${transaction.destination.account.currency}`
    )
  }

  const assignments =
    transaction.kind === 'adjustment'
      ? ''
      : transaction.assignments.length === 0
        ? ', uncategorized'
        : `, ${transaction.assignments
            .map(
              (assignment) =>
                `${assignment.origin} Category "${assignment.categoryPath}" ` +
                `${assignment.amountMinor} ${transaction.account.currency}`,
            )
            .join('; ')}`

  return (
    `${capitalize(transaction.kind)} Transaction ${transaction.id} on ` +
    `${transaction.occurredOn}, ${memo}: Account "${transaction.account.name}" ` +
    `(ID ${transaction.account.id}), ${transaction.amountMinor} ` +
    `${transaction.account.currency}${assignments}`
  )
}

function formatLifecycleBalances(changes: EditTransactionResult['balanceChanges']): string {
  return changes
    .map(
      (change) =>
        `Account ${change.accountId} ${change.currency} balance changed from ` +
        `${change.previousBalanceMinor} to ${change.resultingBalanceMinor}.`,
    )
    .join(' ')
}

function formatRelatedTransactionNotice(
  relatedTransactionCount: number,
  requiresConfirmation: boolean,
): string {
  if (!requiresConfirmation) {
    return 'No related Transactions were identified.'
  }

  return (
    `${relatedTransactionCount} related Transaction(s) were identified; ` +
    'explicit confirmation is required before changing more than this Transaction.'
  )
}

function requireToolNumber(value: number | undefined, field: string): number {
  if (value === undefined) {
    throw new FinError('INVALID_INPUT', `${field} is required for this Transaction kind`, {
      fields: [field],
    })
  }

  return value
}

function formatAccount(account: Account): string {
  return (
    `${formatNature(account.nature)} Account "${account.name}" ` +
    `(${account.currency}, balance ${account.balanceMinor} minor units, ` +
    `archived: ${account.archived ? 'yes' : 'no'})`
  )
}

function formatIncomeExpenseTransaction(transaction: IncomeExpenseTransaction): string {
  const memo = transaction.memo === null ? 'no memo' : `memo "${transaction.memo}"`

  return (
    `${formatNature(transaction.account.nature)} Account "${transaction.account.name}" ` +
    `(ID ${transaction.account.id}, ${transaction.account.currency}) — ` +
    `${formatTransactionKind(transaction.kind)} Transaction ${transaction.id}, ` +
    `${transaction.amountMinor} minor units on ${transaction.occurredOn}, ${memo}`
  )
}

function formatAdjustmentTransaction(transaction: AdjustmentTransaction): string {
  const memo = transaction.memo === null ? 'no memo' : `memo "${transaction.memo}"`

  return (
    `Adjustment Transaction ${transaction.id} for ` +
    `${formatNature(transaction.account.nature)} Account "${transaction.account.name}" ` +
    `(ID ${transaction.account.id}, ${transaction.account.currency}), ` +
    `${transaction.amountMinor} minor units on ${transaction.occurredOn}, ${memo}`
  )
}

function formatTransferTransaction(transaction: TransferTransaction): string {
  const memo = transaction.memo === null ? 'no memo' : `memo "${transaction.memo}"`

  return (
    `Transfer Transaction ${transaction.id} on ${transaction.occurredOn}, ${memo}: ` +
    `${formatNature(transaction.source.account.nature)} source Account ` +
    `"${transaction.source.account.name}" (ID ${transaction.source.account.id}) sends ` +
    `${transaction.source.amountMinor} ${transaction.source.account.currency} minor units; ` +
    `${formatNature(transaction.destination.account.nature)} destination Account ` +
    `"${transaction.destination.account.name}" ` +
    `(ID ${transaction.destination.account.id}) receives ` +
    `${transaction.destination.amountMinor} ` +
    `${transaction.destination.account.currency} minor units`
  )
}

function formatTransactionSnapshot(transaction: TransactionSnapshot): string {
  const memo = transaction.memo === null ? 'no memo' : `memo "${transaction.memo}"`
  const values =
    transaction.kind === 'transfer'
      ? `source Account ${transaction.sourceAccountId} sends ${transaction.sourceAmountMinor}; ` +
        `destination Account ${transaction.destinationAccountId} receives ` +
        `${transaction.destinationAmountMinor} minor units`
      : `Account ${transaction.accountId}, ${transaction.amountMinor} minor units`

  return (
    `${capitalize(transaction.kind)} Transaction ${transaction.id}, ${values} ` +
    `on ${transaction.occurredOn}, ${memo}`
  )
}

function formatTransactionClassification(classification: TransactionClassification): string {
  const assignments =
    classification.assignments.length === 0
      ? 'no Category Assignments'
      : classification.assignments.map(formatCategoryAssignment).join('; ')

  return (
    `${formatTransactionKind(classification.transaction.kind)} Transaction ` +
    `${classification.transaction.id}, ${classification.transaction.amountMinor} ` +
    `${classification.transaction.account.currency}: ${assignments}. ` +
    `Uncategorized remainder: ${classification.uncategorizedAmountMinor} ` +
    `${classification.transaction.account.currency}.`
  )
}

function formatCategoryAssignment(assignment: CategoryAssignment): string {
  return (
    `${assignment.origin} Category "${assignment.category.path}": ` +
    `${assignment.amountMinor} ${assignment.currency}`
  )
}

function formatCategory(category: Category): string {
  return (
    `Category "${category.path}" ` +
    `(depth ${category.depth}, archived: ${category.archived ? 'yes' : 'no'})`
  )
}

function formatNature(nature: Account['nature']): 'Asset' | 'Liability' {
  return nature === 'asset' ? 'Asset' : 'Liability'
}

function formatTransactionKind(kind: IncomeExpenseTransaction['kind']): 'Income' | 'Expense' {
  return kind === 'income' ? 'Income' : 'Expense'
}

function capitalize(value: TransactionSnapshot['kind']): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}
