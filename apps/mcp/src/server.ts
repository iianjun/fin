import {
  type Account,
  type AccountCreation,
  type AccountMutationResult,
  type AccountUpdate,
  type AdjustmentRequest,
  type AdjustmentTransaction,
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
  getIncomeExpenseTransaction,
  getTransactionClassification,
  type IncomeExpenseCreation,
  type IncomeExpenseTransaction,
  initializeVault,
  inspectTransactionRelations,
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
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
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

export type FinOperations = VaultOperations &
  AccountOperations &
  CategoryOperations &
  TransactionOperations &
  QueryOperations

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

  server.registerTool(
    'create_category',
    {
      title: 'Create Category',
      description: 'Create a root or child Category with a path of at most three levels.',
      inputSchema: createCategoryInputSchema,
      outputSchema: createCategoryOutputSchema,
    },
    ({ path, name, parentId }) =>
      createCategoryToolResult(operations.createCategory(path, { name, parentId })),
  )

  server.registerTool(
    'list_categories',
    {
      title: 'List Categories',
      description: 'List Categories with complete current paths and archive state.',
      inputSchema: listCategoriesInputSchema,
      outputSchema: listCategoriesOutputSchema,
    },
    ({ path }) => createListCategoriesToolResult(operations.listCategories(path)),
  )

  server.registerTool(
    'update_category',
    {
      title: 'Update Category',
      description: 'Rename or move a Category while preserving a valid three-level hierarchy.',
      inputSchema: updateCategoryInputSchema,
      outputSchema: categoryMutationOutputSchema,
    },
    ({ path, categoryId, name, parentId }) =>
      createCategoryMutationToolResult(
        operations.updateCategory(path, categoryId, { name, parentId }),
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
    ({ path, categoryId }) =>
      createCategoryMutationToolResult(operations.archiveCategory(path, categoryId)),
  )

  server.registerTool(
    'reactivate_category',
    {
      title: 'Reactivate Category',
      description: 'Reactivate a Category under an active parent.',
      inputSchema: categoryIdInputSchema,
      outputSchema: categoryMutationOutputSchema,
    },
    ({ path, categoryId }) =>
      createCategoryMutationToolResult(operations.reactivateCategory(path, categoryId)),
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
    ({ path, kind, accountId, amountMinor, occurredOn, memo }) =>
      createRecordIncomeExpenseToolResult(
        operations.recordIncomeExpense(path, {
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
    ({ path }) => createListIncomeExpenseToolResult(operations.listIncomeExpenseTransactions(path)),
  )

  server.registerTool(
    'get_income_expense_transaction',
    {
      title: 'Get Income or Expense Transaction',
      description: 'Inspect one Income or Expense Transaction by ID.',
      inputSchema: getIncomeExpenseTransactionInputSchema,
      outputSchema: getIncomeExpenseTransactionOutputSchema,
    },
    ({ path, transactionId }) =>
      createGetIncomeExpenseToolResult(operations.getIncomeExpenseTransaction(path, transactionId)),
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
    ({ path, transactionId, assignments }) =>
      createSetCategoryAssignmentsToolResult(
        operations.setCategoryAssignments(path, transactionId, assignments),
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
    ({ path, transactionId }) =>
      createTransactionClassificationToolResult(
        operations.getTransactionClassification(path, transactionId),
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
    ({ path, accountId, occurredOn, amountMinor, targetBalanceMinor, memo }) =>
      createRecordAdjustmentToolResult(
        operations.recordAdjustment(path, {
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
      path,
      sourceAccountId,
      sourceAmountMinor,
      destinationAccountId,
      destinationAmountMinor,
      occurredOn,
      memo,
    }) =>
      createRecordTransferToolResult(
        operations.recordTransfer(path, {
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
    ({ path, accountId, amountMinor, occurredOn, memo, originalExpenseId }) =>
      createRecordRefundToolResult(
        operations.recordRefund(path, {
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
    ({ path, accountId, amountMinor, occurredOn, memo, transferId }) =>
      createRecordTransferFeeToolResult(
        operations.recordTransferFee(path, {
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
    ({ path, transactionId }) =>
      createTransactionRelationInspectionToolResult(
        operations.inspectTransactionRelations(path, transactionId),
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
      path,
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
        operations.editTransaction(path, {
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
    ({ path, transactionId }) =>
      createDeleteTransactionToolResult(operations.deleteTransaction(path, transactionId)),
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
    ({ path, transactionId }) =>
      createListTransactionChangeRecordsToolResult(
        operations.listTransactionChangeRecords(path, transactionId),
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
    ({ path, deletionChangeRecordId }) =>
      createRecreateTransactionToolResult(
        operations.recreateTransaction(path, deletionChangeRecordId),
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
    ({ path }) => createQueryBalancesToolResult(operations.queryBalances(path)),
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
    ({ path, dateFrom, dateTo, accountId, kinds, memoContains }) =>
      createQueryTransactionsToolResult(
        operations.queryTransactions(path, {
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
    ({ path, dateFrom, dateTo, accountId, memoContains, categoryId }) =>
      createQuerySpendingToolResult(
        operations.querySpending(path, {
          dateFrom,
          dateTo,
          accountId,
          memoContains,
          categoryId,
        }),
      ),
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
    throw new Error(`${field} is required for this Transaction kind`)
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
