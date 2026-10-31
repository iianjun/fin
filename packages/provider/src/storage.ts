import type {
  Account,
  Category,
  ChangeRecord,
  EntityId,
  Transaction,
  TransactionFilters,
  Vault,
  VaultId,
  VaultSettings,
} from './entities.js'

export type ReadRequest =
  | { kind: 'vaults'; includeArchived?: boolean }
  | { kind: 'vault' | 'settings'; vaultId: VaultId }
  | { kind: 'accounts' | 'categories'; vaultId: VaultId; id?: EntityId; includeArchived?: boolean }
  | { kind: 'transactions'; vaultId: VaultId; filters?: TransactionFilters }
  | {
      kind: 'history'
      vaultId: VaultId
      id?: EntityId
      targetId?: EntityId
      limit?: number
      offset?: number
    }

export interface DomainContext {
  vault: Vault | null
  vaults: Vault[]
  settings: VaultSettings | null
  accounts: Account[]
  categories: Category[]
  transactions: Transaction[]
  records: ChangeRecord[]
}
export type MutationRequest =
  | { kind: 'createVault' }
  | { kind: 'vault' | 'settings'; vaultId: VaultId; accountIds?: EntityId[] }
  | { kind: 'account'; vaultId: VaultId; id?: EntityId; name?: string }
  | { kind: 'category'; vaultId: VaultId; id?: EntityId; parentId?: EntityId | null; name?: string }
  | {
      kind: 'transaction'
      vaultId: VaultId
      id?: EntityId
      accountIds?: EntityId[]
      categoryIds?: EntityId[]
      relatedIds?: EntityId[]
      duplicate?: (
        | { kind: 'income' | 'expense'; accountId?: EntityId; amountMinor: number }
        | {
            kind: 'transfer'
            sourceAccountId: EntityId
            sourceAmountMinor: number
            destinationAccountId: EntityId
            destinationAmountMinor: number
          }
      ) & { occurredOn: string; memo: string | null }
      recordId?: EntityId
    }
export interface DomainChanges {
  vault?: Vault
  settings?: VaultSettings
  accounts?: Account[]
  categories?: Category[]
  transactions?: Transaction[]
  deleteTransactionId?: EntityId
}
export type MutationDecision<T> =
  | { kind: 'unchanged'; result: T }
  | { kind: 'changed'; changes: DomainChanges; record: ChangeRecord; result: T }
export interface FinStorage {
  /** Return the requested projection from one consistent snapshot. */
  read(request: ReadRequest): Promise<DomainContext>
  /**
   * Read a consistent context and invoke the synchronous, pure decision once.
   * Reject asynchronous decisions before writing. An unchanged decision writes
   * nothing. Otherwise commit changes, affected revisions and the supplied change
   * record atomically, preserving its snapshots and returning the same result.
   * Protect read dependencies against concurrent writers through commit. Never
   * retry a write or decision automatically; report uncertain commit outcomes
   * with FinError('OUTCOME_UNKNOWN') rather than claiming non-application.
   */
  mutate<T>(
    request: MutationRequest,
    decide: (context: Readonly<DomainContext>) => MutationDecision<T>,
  ): Promise<T>
}
