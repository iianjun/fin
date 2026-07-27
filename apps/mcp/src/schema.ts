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
