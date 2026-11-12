import { AsyncLocalStorage } from 'node:async_hooks'
import { Pool, DatabaseError, type PoolClient } from 'pg'
import { FinError, type FinStorage } from '@fin/provider'
import { prepareSchema } from './schema.js'
import { encodeText, readContext, writeChanges } from './storage.js'

// Decisions cannot start work through a second instance either. Async-local scope
// also rejects an invalid async decision's continuation without blocking unrelated callers.
const deciding = new AsyncLocalStorage<boolean>()

export interface PostgresAdapterOptions {
  connectionString: string
  autoMigrate?: boolean
}

/** Owns sessions, admission, transaction outcomes and preparation; never replays a decision. */
export function createPostgresAdapter(options: PostgresAdapterOptions): FinStorage & {
  migrate(): Promise<void>
  close(): Promise<void>
} {
  if (
    !options ||
    typeof options.connectionString !== 'string' ||
    !/^postgres(?:ql)?:\/\//.test(options.connectionString) ||
    (options.autoMigrate !== undefined && typeof options.autoMigrate !== 'boolean')
  )
    throw new FinError(
      'INVALID_INPUT',
      'A PostgreSQL connection URL is required.',
      'Supply connectionString and an optional boolean autoMigrate.',
    )
  try {
    new URL(options.connectionString)
  } catch {
    throw new FinError(
      'INVALID_INPUT',
      'The PostgreSQL connection URL is invalid.',
      'Supply a valid PostgreSQL connection URL.',
    )
  }
  const pool = new Pool({
    connectionString: options.connectionString,
    connectionTimeoutMillis: 10000,
  })
  const autoMigrate = options.autoMigrate ?? true
  // pg destroys idle clients on error; an owned listener prevents an uncaught process error.
  pool.on('error', () => {})
  const active = new Set<Promise<unknown>>()
  let closing: Promise<void> | undefined

  function execute<T>(
    operation: (client: PoolClient) => Promise<T>,
    mode: 'read' | 'write' | 'migrate',
  ): Promise<T> {
    if (deciding.getStore())
      return Promise.reject(
        new FinError(
          'INVALID_INPUT',
          'Storage operations cannot be nested in a decision.',
          'Keep decisions synchronous and free of storage operations.',
        ),
      )
    if (closing)
      return Promise.reject(
        new FinError(
          'STORAGE_FAILURE',
          'The PostgreSQL adapter is closed.',
          'Create a new adapter.',
        ),
      )
    const pending = (async () => {
      let client: PoolClient | undefined
      let committing = false
      let committed = false
      let broken = false
      const onSessionError = () => {
        broken = true
      }
      try {
        client = await pool.connect()
        // Checked-out clients emit their own errors; the pool listener only owns idle clients.
        client.on('error', onSessionError)
        await prepareSchema(client, mode === 'migrate' || autoMigrate)
        if (mode === 'migrate') return await operation(client)
        await client.query(
          mode === 'read'
            ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'
            : 'BEGIN ISOLATION LEVEL READ COMMITTED',
        )
        await client.query('SET LOCAL search_path = public, pg_catalog')
        const result = await operation(client)
        if (broken) throw new Error('The checked-out session was lost before commit')
        committing = true
        const acknowledgement = await client.query('COMMIT')
        if (acknowledgement.command === 'ROLLBACK') {
          committing = false
          throw new Error('Transaction was rolled back')
        }
        if (acknowledgement.command !== 'COMMIT') throw new Error('Missing commit acknowledgement')
        committed = true
        return result
      } catch (error) {
        broken = true
        const confirmedRejection =
          error instanceof DatabaseError &&
          ((error.code ?? '').startsWith('23') ||
            ['40000', '40001', '40002', '40P01'].includes(error.code ?? ''))
        // Capture outcome evidence BEFORE rollback/cleanup: neither can undo an acknowledged
        // COMMIT nor disprove a commit whose reply was lost.
        const unknown = mode === 'write' && committing && !committed && !confirmedRejection
        if (client) {
          try {
            await client.query('ROLLBACK')
          } catch {
            /* Discard this session below. */
          }
        }
        if (unknown)
          throw new FinError(
            'OUTCOME_UNKNOWN',
            'The commit outcome could not be confirmed.',
            'Inspect financial state and Change Records before deciding whether to submit again.',
            'unknown',
          )
        if (error instanceof FinError) throw error
        if (error instanceof DatabaseError && /^(40001|40P01|23505|55P03)$/.test(error.code ?? ''))
          throw new FinError(
            'CONFLICT',
            'A concurrent storage operation conflicted.',
            'Read current state and reconsider the operation. No decision was replayed.',
          )
        throw new FinError(
          'STORAGE_FAILURE',
          'The PostgreSQL operation failed.',
          'Check database access and integrity before deciding whether to retry.',
        )
      } finally {
        // Cleanup never replaces the financial result or its uncertainty classification.
        if (client) {
          try {
            client.release(broken)
          } catch {
            try {
              await client.end()
            } catch {
              /* Already unusable. */
            }
          }
          client.removeListener('error', onSessionError)
        }
      }
    })()
    active.add(pending)
    void pending.then(
      () => active.delete(pending),
      () => active.delete(pending),
    )
    return pending
  }

  return {
    read: (request) => execute((client) => readContext(client, request), 'read'),
    mutate: (request, decide) =>
      execute(async (client) => {
        if (request.kind !== 'createVault')
          await client.query('SELECT id FROM public.fin_vaults WHERE id=$1 FOR UPDATE', [
            encodeText(request.vaultId),
          ])
        const context = await readContext(client, request)
        const decision = deciding.run(true, () => decide(context))
        if (decision && typeof decision === 'object' && 'then' in decision) {
          void Promise.resolve(decision).catch(() => {})
          throw new FinError(
            'INVALID_INPUT',
            'Mutation decisions must be synchronous.',
            'Return a synchronous decision without I/O.',
          )
        }
        if (decision.kind === 'changed')
          await writeChanges(client, request, decision.changes, decision.record)
        return decision.result
      }, 'write'),
    migrate: () => execute(async () => {}, 'migrate'),
    close() {
      if (deciding.getStore())
        return Promise.reject(
          new FinError(
            'INVALID_INPUT',
            'Storage cannot close inside a decision.',
            'Close the adapter after the operation settles.',
          ),
        )
      closing ??= (async () => {
        await Promise.allSettled(active)
        try {
          await pool.end()
        } catch {
          throw new FinError(
            'STORAGE_FAILURE',
            'The PostgreSQL pool could not close cleanly.',
            'Inspect host resources; do not replay completed writes.',
          )
        }
      })()
      return closing
    },
  }
}
