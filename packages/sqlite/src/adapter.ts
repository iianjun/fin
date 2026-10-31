import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type {
  DomainContext,
  FinStorage,
  MutationDecision,
  MutationRequest,
  ReadRequest,
} from '@fin/provider'
import { FinError } from '@fin/provider'
import { writeChanges } from './storage/changes.js'
import { readContext } from './storage/context.js'
import { SchemaManager } from './storage/migrations.js'

export interface SqliteAdapterOptions {
  filename: string
  autoMigrate?: boolean
}

export function createSqliteAdapter(options: SqliteAdapterOptions): FinStorage & {
  migrate(): Promise<void>
  close(): Promise<void>
} {
  return new SqliteAdapter(options)
}

class SqliteAdapter implements FinStorage {
  readonly #db: Database.Database
  readonly #orm: BetterSQLite3Database
  readonly #schema: SchemaManager
  #deciding = false

  constructor({ filename, autoMigrate = true }: SqliteAdapterOptions) {
    if (typeof filename !== 'string' || filename.trim().length === 0)
      throw new FinError(
        'INVALID_INPUT',
        'A SQLite filename is required.',
        'Provide a database file path or :memory:.',
      )
    let db: Database.Database
    try {
      db = new Database(filename)
    } catch {
      throw new FinError(
        'STORAGE_FAILURE',
        'The SQLite database could not be opened.',
        'Check the database path and access permissions before creating a new adapter.',
      )
    }
    this.#db = db
    this.#orm = drizzle(db)
    this.#schema = new SchemaManager(db, this.#orm, autoMigrate)
    this.close = this.close.bind(this)
    this.migrate = this.migrate.bind(this)
    this.read = this.read.bind(this)
    this.mutate = this.mutate.bind(this)
  }

  #execute<T>(operation: () => T, write = false): T {
    if (!this.#db.open)
      throw new FinError(
        'STORAGE_FAILURE',
        'The SQLite storage adapter is closed.',
        'Create a new adapter before calling fin.',
      )
    if (this.#deciding || this.#db.inTransaction)
      throw new FinError(
        'INVALID_INPUT',
        'Storage operations cannot be nested inside an active transaction.',
        'Keep mutation decisions synchronous and free of storage operations.',
      )
    try {
      return operation()
    } catch (error) {
      if (error instanceof FinError) throw error
      let cause: unknown = error
      while (cause instanceof Error && cause.cause) cause = cause.cause
      const code =
        typeof cause === 'object' &&
        cause !== null &&
        'code' in cause &&
        typeof cause.code === 'string'
          ? cause.code
          : ''
      if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED')
        throw new FinError(
          'CONFLICT',
          'The database is busy with another operation.',
          'Read the latest state and reconsider the operation before submitting again.',
        )
      if (
        write &&
        (code.startsWith('SQLITE_IOERR') ||
          (!this.#db.open && !code.startsWith('SQLITE_CONSTRAINT')))
      )
        throw new FinError(
          'OUTCOME_UNKNOWN',
          'The storage outcome could not be confirmed.',
          'Inspect the target and change records; do not automatically repeat the write.',
          'unknown',
        )
      throw new FinError(
        'STORAGE_FAILURE',
        'The storage operation failed.',
        'Ask the host to inspect database access and integrity before deciding whether to retry.',
      )
    }
  }

  async close() {
    if (!this.#db.open) return
    this.#execute(() => this.#db.close())
  }

  async migrate() {
    this.#execute(() => this.#schema.prepare())
  }

  async read(request: ReadRequest) {
    return this.#execute(() => {
      this.#schema.ready()
      return this.#db.transaction(() => readContext(this.#orm, request))()
    })
  }

  async mutate<T>(
    request: MutationRequest,
    decide: (context: Readonly<DomainContext>) => MutationDecision<T>,
  ): Promise<T> {
    return this.#execute(() => {
      this.#schema.ready()
      return this.#db
        .transaction(() => {
          const context = readContext(this.#orm, request)
          let decision: MutationDecision<T>
          this.#deciding = true
          try {
            decision = decide(context)
          } finally {
            this.#deciding = false
          }
          if (decision && typeof decision === 'object' && 'then' in decision)
            throw new FinError(
              'INVALID_INPUT',
              'Mutation decisions must be synchronous.',
              'Return a synchronous decision without I/O.',
            )
          if (decision.kind === 'unchanged') return decision.result
          const { changes, record } = decision
          writeChanges(this.#orm, request, changes, record)
          return decision.result
        })
        .immediate()
    }, true)
  }
}
