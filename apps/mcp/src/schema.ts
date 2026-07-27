import { z } from 'zod'

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
  settings: z.object({
    defaultIncomeAccountId: z.number().int().nullable(),
    defaultExpenseAccountId: z.number().int().nullable(),
  }),
  accountCount: z.number().int().nonnegative(),
  categoryCount: z.number().int().nonnegative(),
}
