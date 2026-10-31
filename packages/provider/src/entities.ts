export type EntityId = string
export type VaultId = string
export type Revision = string
export interface Vault {
  id: VaultId
  name: string
  revision: Revision
  archived: boolean
}
export interface VaultSettings {
  revision: Revision
  incomeAccountId: EntityId | null
  expenseAccountId: EntityId | null
}
export interface Account {
  id: EntityId
  revision: Revision
  balanceRevision: Revision
  name: string
  nature: 'asset' | 'liability'
  currency: string
  archived: boolean
  hasTransactions: boolean
  balanceMinor: number
}
export interface Category {
  id: EntityId
  revision: Revision
  name: string
  parentId: EntityId | null
  path: string
  archived: boolean
}
export interface CategoryAssignment {
  categoryId: EntityId
  amountMinor: number
  origin: 'explicit' | 'inferred'
}
export interface TransactionRelation {
  kind: 'refund_of' | 'fee_for'
  targetTransactionId: EntityId
}
export interface TransactionBase {
  id: EntityId
  revision: Revision
  occurredOn: string
  memo: string | null
  assignments: CategoryAssignment[]
  relations: TransactionRelation[]
}
export type Transaction = TransactionBase &
  (
    | { kind: 'income' | 'expense' | 'adjustment'; accountId: EntityId; amountMinor: number }
    | {
        kind: 'transfer'
        sourceAccountId: EntityId
        sourceAmountMinor: number
        destinationAccountId: EntityId
        destinationAmountMinor: number
      }
  )
export interface BalanceChange {
  accountId: EntityId
  previousBalanceMinor: number
  resultingBalanceMinor: number
}
export interface TransactionSnapshot {
  relatedTransactions: Transaction[]
  transaction: Transaction
  accounts: Account[]
  categories: Category[]
}
export interface ChangeRecord {
  id: EntityId
  vaultId: VaultId
  target: 'vault' | 'settings' | 'account' | 'category' | 'transaction'
  targetId: EntityId
  action: 'created' | 'updated' | 'deleted' | 'recreated'
  recordedAt: string
  before: Vault | VaultSettings | Account | Category | TransactionSnapshot | null
  after: Vault | VaultSettings | Account | Category | TransactionSnapshot | null
  balances: BalanceChange[]
  settings?: { before: VaultSettings; after: VaultSettings }
}
export interface TransactionFilters {
  id?: EntityId
  accountId?: EntityId
  kinds?: Transaction['kind'][]
  dateFrom?: string
  dateTo?: string
  search?: string
  categoryId?: EntityId
  limit?: number
  offset?: number
}
