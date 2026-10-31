import { FinError, type TransactionFilters } from '@fin/provider'

export function invalid(condition: unknown, message: string): asserts condition {
  if (!condition)
    throw new FinError('INVALID_INPUT', message, 'Correct the input and submit a new operation.')
}
export function required<T>(value: T | undefined | null, id?: string): T {
  if (value == null)
    throw new FinError(
      'NOT_FOUND',
      'The requested entity does not exist in this vault.',
      'List the current entities and select an existing ID.',
      'not_applied',
      { id },
    )
  return value
}
export function revision(actual: string, expected: string) {
  if (actual !== expected)
    throw new FinError(
      'CONFLICT',
      'The entity changed after it was read.',
      'Read the latest entity, reconsider the intended change, and use its new revision.',
    )
}
export function label(value: string) {
  invalid(
    typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 200,
    'Names must contain 1 to 200 characters.',
  )
  return value.trim()
}
export function money(value: number): number {
  invalid(Number.isSafeInteger(value), 'Money must be safe integer minor units.')
  return value
}
export function entityId(value: string) {
  invalid(typeof value === 'string' && value.trim().length > 0, 'An entity ID is required.')
  return value
}
export function queryFilters(filters: TransactionFilters): TransactionFilters {
  if (filters.id !== undefined) entityId(filters.id)
  if (filters.accountId !== undefined) entityId(filters.accountId)
  if (filters.categoryId !== undefined) entityId(filters.categoryId)
  if (filters.dateFrom !== undefined) calendarDate(filters.dateFrom)
  if (filters.dateTo !== undefined) calendarDate(filters.dateTo)
  invalid(
    !filters.dateFrom || !filters.dateTo || filters.dateFrom <= filters.dateTo,
    'The date range is reversed.',
  )
  for (const value of [filters.limit, filters.offset])
    invalid(
      value === undefined || (Number.isSafeInteger(value) && value >= 0),
      'Pagination values must be nonnegative safe integers.',
    )
  if (filters.search !== undefined)
    invalid(
      typeof filters.search === 'string' && filters.search.trim().length > 0,
      'Search text must not be empty.',
    )
  if (filters.kinds !== undefined)
    invalid(
      Array.isArray(filters.kinds) &&
        filters.kinds.every((kind) =>
          ['income', 'expense', 'transfer', 'adjustment'].includes(kind),
        ),
      'Unsupported transaction kind.',
    )
  return {
    ...filters,
    search: filters.search?.trim(),
    kinds: filters.kinds ? [...filters.kinds] : undefined,
  }
}
export function calendarDate(value: string): string {
  invalid(
    typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value),
    'Dates must use YYYY-MM-DD.',
  )
  const date = new Date(`${value}T00:00:00.000Z`)
  invalid(
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value,
    'The calendar date is invalid.',
  )
  return value
}
