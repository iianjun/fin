export const finErrorCodes = [
  'VAULT_NOT_FOUND',
  'VAULT_ALREADY_EXISTS',
  'ENTITY_NOT_FOUND',
  'ENTITY_ARCHIVED',
  'PREREQUISITE_REQUIRED',
  'INVALID_INPUT',
  'INTEGRITY_FAILURE',
] as const

export type FinErrorCode = (typeof finErrorCodes)[number]

export class FinError extends Error {
  readonly code: FinErrorCode
  readonly details: Readonly<Record<string, unknown>>

  constructor(
    code: FinErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message)
    this.name = 'FinError'
    this.code = code
    this.details = details
  }
}

export function isFinError(error: unknown): error is FinError {
  return error instanceof FinError
}
