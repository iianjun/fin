import { Session } from '@tursodatabase/serverless'
import { FinError } from '@fin/provider'
import { z } from 'zod'

export type SqlValue = null | string | number | bigint | Uint8Array
export interface OperationSession {
  execute(
    sql: string,
    args?: readonly SqlValue[],
  ): Promise<{
    columns: (string | null)[]
    rows: SqlValue[][]
    affectedRows: number
  }>
}
type Receipt = Awaited<ReturnType<OperationSession['execute']>>

// A read receipt is valid only for the exact projection (names and order) with
// no writes, so missing, renamed, duplicated or combined columns cannot pass.
export function isProjection(receipt: Receipt, columns: readonly string[]): boolean {
  return (
    receipt.affectedRows === 0 &&
    receipt.columns.length === columns.length &&
    receipt.columns.every((name, i) => name === columns[i])
  )
}

// A write receipt carries no result set and, when known, the exact affected rows.
export function isWrite(receipt: Receipt, affectedRows?: number): boolean {
  return (
    receipt.columns.length === 0 &&
    receipt.rows.length === 0 &&
    (affectedRows === undefined || receipt.affectedRows === affectedRows)
  )
}

// Validate the SDK's decoded result at the storage boundary. Wire encoding,
// HTTP, redirects, batons and response parsing belong to the official SDK.
const resultSchema = z.object({
  columns: z.array(z.string().nullable()),
  rows: z.array(
    z.array(
      z.union([z.null(), z.string(), z.number().finite(), z.bigint(), z.instanceof(Uint8Array)]),
    ),
  ),
  rowsAffected: z.number().int().nonnegative().safe(),
})

// Own operation admission, one SDK session per transaction, outcome mapping and
// draining close. This module does not implement or patch the Turso protocol.
export class TursoSessions {
  private readonly config: { url: string; authToken: string; defaultQueryTimeout: number }
  private readonly active = new Set<Promise<unknown>>()
  private closing: Promise<void> | undefined

  constructor(options: { url: string; authToken: string; timeoutMs?: number }) {
    try {
      const url = new URL(options.url)
      const timeout = options.timeoutMs ?? 10000
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.pathname !== '/' ||
        url.search ||
        url.hash ||
        typeof options.authToken !== 'string' ||
        !options.authToken.trim() ||
        /[\r\n]/.test(options.authToken) ||
        !Number.isSafeInteger(timeout) ||
        timeout < 1 ||
        timeout > 60000
      )
        throw new Error('Invalid settings')
      this.config = { url: url.origin, authToken: options.authToken, defaultQueryTimeout: timeout }
    } catch {
      throw new FinError(
        'INVALID_INPUT',
        'Invalid Turso connection settings.',
        'Supply an HTTPS origin, token and valid query timeout.',
      )
    }
  }

  // Run one operation inside its own BEGIN IMMEDIATE transaction and SDK session.
  transaction<T>(operation: (session: OperationSession) => Promise<T>): Promise<T> {
    if (this.closing)
      return Promise.reject(
        new FinError('STORAGE_FAILURE', 'Turso storage is closed.', 'Create a new adapter.'),
      )
    const session = new Session(this.config)
    const work = (async () => {
      // Once a statement may have persisted outside the transaction, or COMMIT
      // was submitted, a failure can no longer be reported as "not applied".
      let outcomeUnknown = false
      let transaction = false
      const execute: OperationSession['execute'] = async (sql, args = []) => {
        // Use the SDK's public batch API with one statement and raw bigint rows.
        // No custom HTTP implementation or SDK-private access is involved.
        const result: unknown = await session.batch(
          [{ sql, args: [...args] }],
          undefined,
          undefined,
          true,
          true,
        )
        if (transaction && !session.inTransaction) {
          // The server ended the transaction, so this statement may have run
          // and persisted in autocommit while earlier ones were rolled back.
          outcomeUnknown = true
          throw new Error('Transaction ended')
        }
        const [decoded] = z.array(resultSchema).length(1).parse(result)
        if (!decoded || decoded.rows.some((row) => row.length !== decoded.columns.length))
          throw new Error('Invalid SDK result')
        return { columns: decoded.columns, rows: decoded.rows, affectedRows: decoded.rowsAffected }
      }
      try {
        await execute('PRAGMA foreign_keys = ON')
        const enabled = await execute('PRAGMA foreign_keys')
        if (enabled.rows.length !== 1 || enabled.rows[0]?.[0] !== 1n)
          throw new Error('Foreign keys are unavailable')
        await execute('BEGIN IMMEDIATE')
        if (!session.inTransaction) throw new Error('Transaction did not begin')
        transaction = true
        const result = await operation({ execute })
        transaction = false
        outcomeUnknown = true
        await execute('COMMIT')
        // A receipt without an authoritative autocommit answer leaves the SDK
        // reporting the transaction as open; that is not an acknowledged commit.
        if (session.inTransaction) throw new Error('Commit not acknowledged')
        return result
      } catch (error) {
        if (outcomeUnknown)
          throw new FinError(
            'OUTCOME_UNKNOWN',
            'Turso commit outcome is unknown.',
            'Inspect persisted state and history before submitting another operation.',
            'unknown',
          )
        if (error instanceof FinError) throw error
        throw new FinError(
          'STORAGE_FAILURE',
          'The Turso storage operation failed.',
          'Check connection, schema and SDK compatibility before submitting another operation.',
        )
      } finally {
        if (session.inTransaction) await session.batch(['ROLLBACK']).catch(() => {})
        // SDK close is best effort and has its own limitations. Cleanup cannot
        // change an acknowledged outcome or resolve an uncertain commit.
        await session.close().catch(() => {})
      }
    })()
    this.active.add(work)
    void work.finally(() => this.active.delete(work)).catch(() => {})
    return work
  }

  close(): Promise<void> {
    this.closing ??= Promise.allSettled(this.active).then(() => {})
    return this.closing
  }
}
