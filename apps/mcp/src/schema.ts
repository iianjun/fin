import { z } from 'zod'

const accountSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
  nature: z.enum(['asset', 'liability']),
  currency: z.string().regex(/^[A-Z]{3}$/),
  archived: z.boolean(),
  balanceMinor: z.number().int(),
})

const vaultSettingsSchema = z.object({
  defaultIncomeAccountId: z.number().int().positive().nullable(),
  defaultExpenseAccountId: z.number().int().positive().nullable(),
})

const categorySchema = z.object({
  id: z.number().int().positive(),
  parentId: z.number().int().positive().nullable(),
  name: z.string().min(1),
  depth: z.number().int().min(1).max(3),
  path: z.string().min(1),
  archived: z.boolean(),
})

const transactionAccountSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
  nature: z.enum(['asset', 'liability']),
  currency: z.string().regex(/^[A-Z]{3}$/),
  archived: z.boolean(),
})

const incomeExpenseTransactionSchema = z.object({
  id: z.number().int().positive(),
  kind: z.enum(['income', 'expense']),
  occurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  account: transactionAccountSchema,
  amountMinor: z
    .number()
    .int()
    .refine((amount) => amount !== 0),
  memo: z.string().min(1).nullable(),
})

const categoryAssignmentSchema = z.object({
  id: z.number().int().positive(),
  category: z.object({
    id: z.number().int().positive(),
    path: z.string().min(1),
  }),
  amountMinor: z
    .number()
    .int()
    .refine((amount) => amount !== 0),
  origin: z.enum(['explicit', 'inferred']),
  currency: z.string().regex(/^[A-Z]{3}$/),
})

const adjustmentTransactionSchema = z.object({
  id: z.number().int().positive(),
  kind: z.literal('adjustment'),
  occurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  account: transactionAccountSchema,
  amountMinor: z
    .number()
    .int()
    .refine((amount) => amount !== 0),
  memo: z.string().min(1).nullable(),
})

const transferEndpointSchema = z.object({
  account: transactionAccountSchema,
  amountMinor: z.number().int().positive(),
})

const transferTransactionSchema = z.object({
  id: z.number().int().positive(),
  kind: z.literal('transfer'),
  occurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  source: transferEndpointSchema,
  destination: transferEndpointSchema,
  memo: z.string().min(1).nullable(),
})

const transactionSnapshotSchema = z.object({
  id: z.number().int().positive(),
  kind: z.enum(['income', 'expense', 'transfer', 'adjustment']),
  occurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  memo: z.string().min(1).nullable(),
  accountId: z.number().int().positive().nullable(),
  amountMinor: z.number().int().nullable(),
  sourceAccountId: z.number().int().positive().nullable(),
  sourceAmountMinor: z.number().int().positive().nullable(),
  destinationAccountId: z.number().int().positive().nullable(),
  destinationAmountMinor: z.number().int().positive().nullable(),
})

const appliedTransactionRelationSchema = z.object({
  kind: z.enum(['refund_of', 'fee_for']),
  targetTransactionId: z.number().int().positive(),
})

export const initializeVaultInputSchema = {
  path: z.string().min(1).describe('Local folder to initialize as a Vault'),
}

export const openVaultInputSchema = {
  path: z.string().min(1).describe('Local Vault folder to open'),
}

export const vaultStateOutputSchema = {
  action: z.enum(['initialized', 'opened']),
  path: z.string(),
  databasePath: z.string(),
  schemaVersion: z.number().int().nonnegative(),
  settings: vaultSettingsSchema,
  accountCount: z.number().int().nonnegative(),
  categoryCount: z.number().int().nonnegative(),
}

export const createAccountInputSchema = {
  path: z.string().min(1).describe('Local Vault folder'),
  name: z.string().min(1).describe('Unique Account name'),
  nature: z.enum(['asset', 'liability']).describe('Whether the Account stores money or debt'),
  currency: z.string().min(1).describe('Three-letter currency code such as KRW or USD'),
}

export const createAccountOutputSchema = {
  action: z.literal('created'),
  account: accountSchema,
}

export const listAccountsInputSchema = {
  path: z.string().min(1).describe('Local Vault folder'),
}

export const listAccountsOutputSchema = {
  accounts: z.array(accountSchema),
}

export const setDefaultAccountInputSchema = {
  path: z.string().min(1).describe('Local Vault folder'),
  kind: z.enum(['income', 'expense']).describe('Default Account setting to change'),
  accountId: z
    .number()
    .int()
    .positive()
    .nullable()
    .describe('Account ID to select, or null to clear the setting'),
}

export const setDefaultAccountOutputSchema = {
  action: z.literal('updated'),
  kind: z.enum(['income', 'expense']),
  selectedAccount: accountSchema.nullable(),
  settings: vaultSettingsSchema,
}

export const updateAccountInputSchema = {
  path: z.string().min(1).describe('Local Vault folder'),
  accountId: z.number().int().positive().describe('Account ID to update'),
  name: z.string().min(1).optional().describe('New unique Account name'),
  nature: z
    .enum(['asset', 'liability'])
    .optional()
    .describe('New Account nature, allowed only before its first Transaction'),
  currency: z
    .string()
    .min(1)
    .optional()
    .describe('New three-letter currency code, allowed only before its first Transaction'),
}

export const accountIdInputSchema = {
  path: z.string().min(1).describe('Local Vault folder'),
  accountId: z.number().int().positive().describe('Account ID'),
}

export const accountMutationOutputSchema = {
  action: z.literal('updated'),
  mutation: z.enum(['details_updated', 'archived', 'reactivated']),
  previousAccount: accountSchema,
  account: accountSchema,
}

export const createCategoryInputSchema = {
  path: z.string().min(1).describe('Local Vault folder'),
  name: z.string().min(1).describe('Category name, unique among siblings'),
  parentId: z
    .number()
    .int()
    .positive()
    .nullable()
    .optional()
    .describe('Parent Category ID, or null/omitted for a root Category'),
}

export const createCategoryOutputSchema = {
  action: z.literal('created'),
  category: categorySchema,
}

export const listCategoriesInputSchema = {
  path: z.string().min(1).describe('Local Vault folder'),
}

export const listCategoriesOutputSchema = {
  categories: z.array(categorySchema),
}

export const updateCategoryInputSchema = {
  path: z.string().min(1).describe('Local Vault folder'),
  categoryId: z.number().int().positive().describe('Category ID to update'),
  name: z.string().min(1).optional().describe('New sibling-unique Category name'),
  parentId: z
    .number()
    .int()
    .positive()
    .nullable()
    .optional()
    .describe('New parent Category ID, or null to move to the root'),
}

export const categoryIdInputSchema = {
  path: z.string().min(1).describe('Local Vault folder'),
  categoryId: z.number().int().positive().describe('Category ID'),
}

export const categoryMutationOutputSchema = {
  action: z.literal('updated'),
  mutation: z.enum(['details_updated', 'archived', 'reactivated']),
  previousCategory: categorySchema,
  category: categorySchema,
}

export const recordIncomeExpenseInputSchema = {
  path: z.string().min(1).describe('Local Vault folder'),
  kind: z.enum(['income', 'expense']).describe('Transaction kind'),
  accountId: z.number().int().positive().describe('Active Account ID'),
  amountMinor: z.number().int().positive().describe('Positive amount in currency minor units'),
  occurredOn: z.string().describe('Calendar date in YYYY-MM-DD format'),
  memo: z.string().nullable().optional().describe('Optional concise memo'),
}

export const recordIncomeExpenseOutputSchema = {
  action: z.literal('created'),
  transaction: incomeExpenseTransactionSchema,
  previousBalanceMinor: z.number().int(),
  resultingBalanceMinor: z.number().int(),
}

export const listIncomeExpenseTransactionsInputSchema = {
  path: z.string().min(1).describe('Local Vault folder'),
}

export const listIncomeExpenseTransactionsOutputSchema = {
  transactions: z.array(incomeExpenseTransactionSchema),
}

export const getIncomeExpenseTransactionInputSchema = {
  path: z.string().min(1).describe('Local Vault folder'),
  transactionId: z.number().int().positive().describe('Income or Expense Transaction ID'),
}

export const getIncomeExpenseTransactionOutputSchema = {
  transaction: incomeExpenseTransactionSchema,
}

export const setCategoryAssignmentsInputSchema = {
  path: z.string().min(1).describe('Local Vault folder'),
  transactionId: z.number().int().positive().describe('Income or Expense Transaction ID'),
  assignments: z
    .array(
      z.object({
        categoryId: z.number().int().positive(),
        amountMinor: z
          .number()
          .int()
          .refine((amount) => amount !== 0),
        origin: z.enum(['explicit', 'inferred']),
      }),
    )
    .describe('Complete replacement set of Category Assignments'),
}

export const setCategoryAssignmentsOutputSchema = {
  action: z.literal('updated'),
  transaction: incomeExpenseTransactionSchema,
  previousAssignments: z.array(categoryAssignmentSchema),
  assignments: z.array(categoryAssignmentSchema),
  uncategorizedAmountMinor: z.number().int(),
}

export const getTransactionClassificationInputSchema = {
  path: z.string().min(1).describe('Local Vault folder'),
  transactionId: z.number().int().positive().describe('Income or Expense Transaction ID'),
}

export const getTransactionClassificationOutputSchema = {
  transaction: incomeExpenseTransactionSchema,
  assignments: z.array(categoryAssignmentSchema),
  uncategorizedAmountMinor: z.number().int(),
}

export const recordAdjustmentInputSchema = {
  path: z.string().min(1).describe('Local Vault folder'),
  accountId: z.number().int().positive().describe('Active Account ID'),
  occurredOn: z.string().describe('Calendar date in YYYY-MM-DD format'),
  amountMinor: z
    .number()
    .int()
    .refine((amount) => amount !== 0)
    .optional()
    .describe('Signed balance delta; mutually exclusive with targetBalanceMinor'),
  targetBalanceMinor: z
    .number()
    .int()
    .optional()
    .describe('Requested resulting balance; mutually exclusive with amountMinor'),
  memo: z.string().nullable().optional().describe('Optional concise memo'),
}

export const recordAdjustmentOutputSchema = {
  action: z.literal('created'),
  transaction: adjustmentTransactionSchema,
  previousBalanceMinor: z.number().int(),
  adjustmentAmountMinor: z
    .number()
    .int()
    .refine((amount) => amount !== 0),
  resultingBalanceMinor: z.number().int(),
  requestedTargetBalanceMinor: z.number().int().nullable(),
}

export const recordTransferInputSchema = {
  path: z.string().min(1).describe('Local Vault folder'),
  sourceAccountId: z.number().int().positive().describe('Active source Account ID'),
  sourceAmountMinor: z.number().int().positive().describe('Actual positive source amount'),
  destinationAccountId: z.number().int().positive().describe('Active destination Account ID'),
  destinationAmountMinor: z
    .number()
    .int()
    .positive()
    .describe('Actual positive destination amount'),
  occurredOn: z.string().describe('Calendar date in YYYY-MM-DD format'),
  memo: z.string().nullable().optional().describe('Optional concise memo'),
}

export const recordTransferOutputSchema = {
  action: z.literal('created'),
  transaction: transferTransactionSchema,
  sourcePreviousBalanceMinor: z.number().int(),
  sourceResultingBalanceMinor: z.number().int(),
  destinationPreviousBalanceMinor: z.number().int(),
  destinationResultingBalanceMinor: z.number().int(),
}

export const recordRefundInputSchema = {
  path: z.string().min(1).describe('Local Vault folder'),
  accountId: z.number().int().positive().describe('Active Account receiving the Refund'),
  amountMinor: z.number().int().positive().describe('Positive Refund magnitude in minor units'),
  occurredOn: z.string().describe('Calendar date in YYYY-MM-DD format'),
  memo: z.string().nullable().optional().describe('Optional concise memo'),
  originalExpenseId: z
    .number()
    .int()
    .positive()
    .nullable()
    .optional()
    .describe('Optional positive original Expense Transaction ID'),
}

export const recordTransferFeeInputSchema = {
  path: z.string().min(1).describe('Local Vault folder'),
  accountId: z.number().int().positive().describe('Active Account charged the fee'),
  amountMinor: z.number().int().positive().describe('Positive fee amount in minor units'),
  occurredOn: z.string().describe('Calendar date in YYYY-MM-DD format'),
  memo: z.string().nullable().optional().describe('Optional concise memo'),
  transferId: z.number().int().positive().describe('Related Transfer Transaction ID'),
}

export const recordRelatedExpenseOutputSchema = {
  action: z.literal('created'),
  transaction: incomeExpenseTransactionSchema,
  relation: appliedTransactionRelationSchema.nullable(),
  previousBalanceMinor: z.number().int(),
  resultingBalanceMinor: z.number().int(),
}

export const inspectTransactionRelationsInputSchema = {
  path: z.string().min(1).describe('Local Vault folder'),
  transactionId: z.number().int().positive().describe('Transaction ID to inspect'),
}

export const inspectTransactionRelationsOutputSchema = {
  transaction: transactionSnapshotSchema,
  relatedTransactions: z.array(
    z.object({
      relationKind: z.enum(['refund_of', 'fee_for']),
      direction: z.enum(['incoming', 'outgoing']),
      transaction: transactionSnapshotSchema,
    }),
  ),
  requiresConfirmationBeforeMultiTransactionChange: z.boolean(),
}
