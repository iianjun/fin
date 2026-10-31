export type FinErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'STORAGE_FAILURE'
  | 'OUTCOME_UNKNOWN'
  | 'FORBIDDEN'
  | 'VAULT_ARCHIVED'
  | 'SCHEMA_INCOMPATIBLE'
  | 'DUPLICATE_CANDIDATE'

export class FinError extends Error {
  readonly name = 'FinError'
  constructor(
    readonly code: FinErrorCode,
    message: string,
    readonly recovery: string,
    readonly application: 'not_applied' | 'unknown' = 'not_applied',
    readonly target?: { vaultId?: string; id?: string },
  ) {
    super(message)
  }
}
