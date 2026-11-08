import { FinError, type Fin, type Vault } from '@fin/core'
import * as z from 'zod'

/** Host-owned authorization. Every method must enforce the current caller's scope. */
export interface FinVaultAccess {
  listVaults(options: { includeArchived?: boolean }): Promise<readonly Vault[]>
  createVault(input: { name: string }): Promise<{ changed: boolean; vault: Vault }>
  getFin(vaultId: string): Promise<Fin>
}

/** Transport-independent descriptor; execute validates untrusted runtime input too. */
export interface FinTool<S extends z.ZodType = z.ZodType, Output = unknown> {
  id: string
  description: string
  inputSchema: S
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean }
  execute(input: z.input<S>, access?: FinVaultAccess): Promise<Output>
}

const id = z.string().refine((value) => value.trim().length > 0, 'An opaque ID is required.')
const name = z.string().trim().min(1).max(200)
const money = z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER)
const date = z.iso.date()
const expectedRevision = id.describe(
  'Revision from the latest read; never invent or reuse after a conflict.',
)
const pagination = {
  limit: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
}
const filters = {
  id: id.optional(),
  accountId: id.optional(),
  kinds: z.array(z.enum(['income', 'expense', 'transfer', 'adjustment'])).optional(),
  dateFrom: date.optional(),
  dateTo: date.optional(),
  search: id.optional(),
  categoryId: id.optional(),
  ...pagination,
}
const assignment = z.strictObject({
  categoryId: id,
  amountMinor: money,
  origin: z.enum(['explicit', 'inferred']),
})
const relation = z.strictObject({ kind: z.enum(['refund_of', 'fee_for']), targetTransactionId: id })
const dated = { occurredOn: date.optional(), memo: z.string().nullable().optional() }
const amount = {
  accountId: id.optional(),
  amountMinor: money,
  ...dated,
  allowDuplicate: z.boolean().optional(),
}

function defineTool<S extends z.ZodType, Output>(
  toolId: string,
  description: string,
  inputSchema: S,
  readOnly: boolean,
  run: (input: z.output<S>, access: FinVaultAccess) => Promise<Output>,
): FinTool<S, Output> {
  return {
    id: toolId,
    description,
    inputSchema,
    annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: readOnly },
    async execute(input, access) {
      const parsed = inputSchema.safeParse(input)
      if (!parsed.success)
        throw new FinError(
          'INVALID_INPUT',
          z.prettifyError(parsed.error),
          'Correct the tool arguments using its input schema; no operation was applied.',
        )
      if (!access)
        throw new FinError(
          'FORBIDDEN',
          'No authorized Vault access was supplied.',
          'Ask the host to provide authenticated Vault access.',
        )
      return run(parsed.data, access)
    },
  }
}

function scopedTool<S extends z.ZodRawShape, Output>(
  toolId: string,
  description: string,
  shape: S,
  readOnly: boolean,
  run: (fin: Fin, input: z.output<z.ZodObject<S>>) => Promise<Output>,
) {
  const schema = z.strictObject({
    ...shape,
    vaultId: id.describe('Authorized Vault ID from vaults.list or vaults.create.'),
  })
  return defineTool(toolId, description, schema, readOnly, async (input, access) => {
    const { vaultId } = z.object({ vaultId: id }).parse(input)
    const fin = await access.getFin(vaultId)
    // ZodObject's generic intersection cannot express removing the added vaultId.
    // Re-parse the declared shape rather than asserting a correlated input type.
    const data = z.object(shape).parse(input)
    return run(fin, data)
  })
}

const catalog = {
  'vaults.list': defineTool(
    'list_vaults',
    'List authorized Vaults and revisions. No Vault ID required. Include archived Vaults explicitly.',
    z.strictObject({ includeArchived: z.boolean().optional() }),
    true,
    (input, access) => access.listVaults(input),
  ),
  'vaults.resolve': defineTool(
    'resolve_vaults',
    'Resolve an exact name among authorized Vaults. Returns all matches; ask the user to choose an ID if ambiguous.',
    z.strictObject({ name: z.string().trim().min(1), includeArchived: z.boolean().optional() }),
    true,
    async (input, access) =>
      (await access.listVaults({ includeArchived: input.includeArchived })).filter(
        (vault) => vault.name === input.name,
      ),
  ),
  'vaults.create': defineTool(
    'create_vault',
    'Create an empty Vault in the host-authorized destination. Use the returned ID for financial calls.',
    z.strictObject({ name: z.string().trim().min(1) }),
    false,
    (input, access) => access.createVault(input),
  ),
  'vaults.get': scopedTool(
    'get_vault',
    'Read Vault metadata and its current revision.',
    {},
    true,
    (fin) => fin.getVault(),
  ),
  'vaults.rename': scopedTool(
    'rename_vault',
    'Rename a Vault while preserving its identity.',
    { name, expectedRevision },
    false,
    (fin, input) =>
      fin.updateVault({ expectedRevision: input.expectedRevision, patch: { name: input.name } }),
  ),
  'vaults.archive': scopedTool(
    'archive_vault',
    'Explicitly archive a Vault. Data and history stay readable; financial writes are rejected.',
    { expectedRevision },
    false,
    (fin, input) =>
      fin.updateVault({ expectedRevision: input.expectedRevision, patch: { archived: true } }),
  ),
  'vaults.reactivate': scopedTool(
    'reactivate_vault',
    'Reactivate an archived Vault to permit financial writes.',
    { expectedRevision },
    false,
    (fin, input) =>
      fin.updateVault({ expectedRevision: input.expectedRevision, patch: { archived: false } }),
  ),
  'settings.get': scopedTool(
    'get_settings',
    'Read persistent income/expense default accounts and settings revision.',
    {},
    true,
    (fin) => fin.getSettings(),
  ),
  'accounts.list': scopedTool(
    'list_accounts',
    'List accounts, balances and revisions in one Vault.',
    { includeArchived: z.boolean().optional() },
    true,
    (fin, input) => fin.listAccounts(input),
  ),
  'accounts.get': scopedTool(
    'get_account',
    'Read an account including its entity and balance revisions.',
    { id },
    true,
    (fin, input) => fin.getAccount(input),
  ),
  'accounts.create': scopedTool(
    'create_account',
    'Create an empty asset or liability account with an ISO currency code.',
    { name, nature: z.enum(['asset', 'liability']), currency: z.string().regex(/^[A-Z]{3}$/) },
    false,
    (fin, input) => fin.createAccount(input),
  ),
  'accounts.update': scopedTool(
    'update_account',
    'Update account metadata using its latest entity revision.',
    {
      id,
      expectedRevision,
      patch: z.strictObject({
        name: name.optional(),
        nature: z.enum(['asset', 'liability']).optional(),
        currency: z
          .string()
          .regex(/^[A-Z]{3}$/)
          .optional(),
        archived: z.boolean().optional(),
      }),
    },
    false,
    (fin, input) => fin.updateAccount(input),
  ),
  'accounts.setDefault': scopedTool(
    'set_default_account',
    'Set or clear a persistent default account using the settings revision.',
    { kind: z.enum(['income', 'expense']), accountId: id.nullable(), expectedRevision },
    false,
    (fin, input) => fin.setDefaultAccount(input),
  ),
  'accounts.adjustBalance': scopedTool(
    'adjust_account_balance',
    'Set a target balance in safe integer minor units using the latest balanceRevision as expectedRevision.',
    { accountId: id, expectedRevision, targetBalanceMinor: money, ...dated },
    false,
    (fin, input) => fin.adjustAccountBalance(input),
  ),
  'categories.list': scopedTool(
    'list_categories',
    'List category paths in one Vault.',
    { includeArchived: z.boolean().optional() },
    true,
    (fin, input) => fin.listCategories(input),
  ),
  'categories.create': scopedTool(
    'create_category',
    'Create a category under an optional parent; at most three levels.',
    { name, parentId: id.nullable().optional() },
    false,
    (fin, input) => fin.createCategory(input),
  ),
  'categories.update': scopedTool(
    'update_category',
    'Update a category with its latest revision, preserving subtree constraints.',
    {
      id,
      expectedRevision,
      patch: z.strictObject({
        name: name.optional(),
        parentId: id.nullable().optional(),
        archived: z.boolean().optional(),
      }),
    },
    false,
    (fin, input) => fin.updateCategory(input),
  ),
  'transactions.recordIncomeExpense': scopedTool(
    'record_income_expense',
    'Record income or expense in safe integer minor units. An omitted date uses the host timezone; an omitted account uses Vault defaults.',
    { kind: z.enum(['income', 'expense']), ...amount, assignments: z.array(assignment).optional() },
    false,
    (fin, input) => fin.recordIncomeExpense(input),
  ),
  'transactions.recordTransfer': scopedTool(
    'record_transfer',
    'Transfer between two accounts using explicit source and destination minor-unit amounts. No automatic FX conversion.',
    {
      sourceAccountId: id,
      sourceAmountMinor: money,
      destinationAccountId: id,
      destinationAmountMinor: money,
      ...dated,
      allowDuplicate: z.boolean().optional(),
    },
    false,
    (fin, input) => fin.recordTransfer(input),
  ),
  'transactions.recordTransferFee': scopedTool(
    'record_transfer_fee',
    'Record a positive fee linked to a transfer.',
    { ...amount, transferId: id },
    false,
    (fin, input) => fin.recordTransferFee(input),
  ),
  'transactions.recordRefund': scopedTool(
    'record_refund',
    'Record a positive refund amount as a negative expense, optionally linked to its original expense.',
    { ...amount, originalExpenseId: id.optional() },
    false,
    (fin, input) => fin.recordRefund(input),
  ),
  'transactions.recordAdjustment': scopedTool(
    'record_adjustment',
    'Record a signed balance adjustment in safe integer minor units.',
    { accountId: id, amountMinor: money, ...dated },
    false,
    (fin, input) => fin.recordAdjustment(input),
  ),
  'transactions.edit': scopedTool(
    'edit_transaction',
    'Edit a transaction using its latest revision. A valid no-op creates no history or revision.',
    {
      id,
      expectedRevision,
      patch: z.strictObject({
        ...dated,
        accountId: id.optional(),
        amountMinor: money.optional(),
        sourceAccountId: id.optional(),
        sourceAmountMinor: money.optional(),
        destinationAccountId: id.optional(),
        destinationAmountMinor: money.optional(),
        assignments: z.array(assignment).optional(),
        relations: z.array(relation).optional(),
      }),
    },
    false,
    (fin, input) => fin.editTransaction(input),
  ),
  'transactions.setCategoryAssignments': scopedTool(
    'set_category_assignments',
    'Replace the full classification using the transaction revision. Assignments use signed minor-unit amounts.',
    { id, expectedRevision, assignments: z.array(assignment) },
    false,
    (fin, input) => fin.setCategoryAssignments(input),
  ),
  'transactions.delete': scopedTool(
    'delete_transaction',
    'Delete a transaction using its revision, preserving immutable history.',
    { id, expectedRevision },
    false,
    (fin, input) => fin.deleteTransaction(input),
  ),
  'transactions.recreate': scopedTool(
    'recreate_transaction',
    'Recreate a deleted transaction from its deletion Change Record with a new identity.',
    { changeRecordId: id },
    false,
    (fin, input) => fin.recreateTransaction(input),
  ),
  'transactions.get': scopedTool(
    'get_transaction',
    'Read a transaction and its revision.',
    { id },
    true,
    (fin, input) => fin.getTransaction(input),
  ),
  'transactions.list': scopedTool(
    'list_transactions',
    'List transactions in one Vault using explicit filters and pagination.',
    filters,
    true,
    (fin, input) => fin.listTransactions(input),
  ),
  'transactions.query': scopedTool(
    'query_transactions',
    'Query transactions with accounts, categories and income/expense totals separated by currency.',
    filters,
    true,
    (fin, input) => fin.queryTransactions(input),
  ),
  'balances.query': scopedTool(
    'query_balances',
    'Read balances and net worth separated by currency; liabilities reduce net worth.',
    {},
    true,
    (fin) => fin.queryBalances(),
  ),
  'spending.query': scopedTool(
    'query_spending',
    'Query expense totals, uncategorized spending and category rollups by currency.',
    {
      accountId: filters.accountId,
      dateFrom: filters.dateFrom,
      dateTo: filters.dateTo,
      search: filters.search,
      categoryId: filters.categoryId,
    },
    true,
    (fin, input) => fin.querySpending(input),
  ),
  'changes.list': scopedTool(
    'list_change_records',
    'Inspect immutable before/after history, especially before deciding what to do after an unknown commit outcome.',
    { targetId: id.optional(), ...pagination },
    true,
    (fin, input) => fin.listChangeRecords(input),
  ),
}

export type FinToolName = keyof typeof catalog
const available: ReadonlyMap<string, FinTool> = new Map(Object.entries(catalog))

export function createFinTools<const Name extends FinToolName = FinToolName>(
  options: { tools?: readonly Name[]; access?: FinVaultAccess } = {},
): Pick<typeof catalog, Name> {
  const entries = options.tools ?? [...available.keys()]
  const selected = Object.fromEntries(
    entries.map((key) => {
      const tool = available.get(key)
      if (!tool)
        throw new FinError(
          'INVALID_INPUT',
          `Unknown tool: ${key}`,
          'Select a documented tool name.',
        )
      return [
        key,
        {
          ...tool,
          execute(input: unknown, access?: FinVaultAccess) {
            return tool.execute(input, access ?? options.access)
          },
        },
      ]
    }),
  )
  // Every requested key is checked above and retains its own schema/executor pair.
  // Object.fromEntries cannot preserve that key/value correlation in TypeScript.
  return selected as Pick<typeof catalog, Name>
}
