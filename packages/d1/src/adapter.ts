import { eq, getTableColumns, getTableName, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/sqlite-proxy'
import type {
  DomainContext,
  FinStorage,
  MutationDecision,
  MutationRequest,
  ReadRequest,
} from '@fin/provider'
import { FinError } from '@fin/provider'
import { readContext } from './storage/context.js'
import { planChanges } from './storage/changes.js'
import * as schema from './storage/schema.js'

export interface D1AdapterOptions {
  accountId: string
  databaseId: string
  apiToken: string
  autoMigrate?: boolean
  /** Optional HTTP transport customization. The transport must not retry writes. */
  fetch?: typeof globalThis.fetch
}

export function createD1Adapter(
  options: D1AdapterOptions,
): FinStorage & { migrate(): Promise<void> } {
  return new D1Adapter(options)
}

class D1Adapter implements FinStorage {
  readonly #url: string
  readonly #token: string
  readonly #fetch: typeof globalThis.fetch
  readonly #autoMigrate: boolean
  readonly #orm
  #preparing: Promise<void> | undefined
  #deciding = false

  constructor(options: D1AdapterOptions) {
    for (const value of [options.accountId, options.databaseId, options.apiToken]) {
      if (typeof value !== 'string' || !value.trim())
        throw new FinError(
          'INVALID_INPUT',
          'D1 connection options are required.',
          'Provide accountId, databaseId and apiToken.',
        )
    }
    this.#url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(options.accountId)}/d1/database/${encodeURIComponent(options.databaseId)}/raw`
    this.#token = options.apiToken
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.#autoMigrate = options.autoMigrate ?? true
    this.#orm = drizzle(async (sql, params: unknown[]) => {
      const [result] = await this.#request([{ sql, params }])
      const rows = result ?? []
      return { rows }
    })
    this.read = this.read.bind(this)
    this.mutate = this.mutate.bind(this)
    this.migrate = this.migrate.bind(this)
  }

  async #request(
    queries: { sql: string; params: unknown[] }[],
    write = false,
  ): Promise<unknown[][][]> {
    // The public REST schema documents string parameters. Keep text bound and
    // encode only validated integers/NULL as SQL literals, preserving their SQL
    // types without depending on undocumented numeric/null JSON bindings.
    const batch = queries.map((query) => {
      const params: string[] = []
      let position = 0
      const sql = query.sql.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|\?/g, (token) => {
        if (token !== '?') return token
        const value: unknown = query.params[position++]
        if (value === null) return 'NULL'
        if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value)
        if (typeof value === 'string') {
          params.push(value)
          return '?'
        }
        throw new FinError(
          'INVALID_INPUT',
          'A query parameter cannot be represented safely.',
          'Use safe integer minor units and supported text values.',
        )
      })
      if (
        position !== query.params.length ||
        params.length > 100 ||
        new TextEncoder().encode(sql).length > 100_000
      )
        throw new FinError(
          'INVALID_INPUT',
          'The query exceeds D1 input limits.',
          'Reduce the operation size before submitting again.',
        )
      return { sql, params }
    })
    const failure = new FinError(
      write ? 'OUTCOME_UNKNOWN' : 'STORAGE_FAILURE',
      'The D1 response could not be confirmed.',
      write
        ? 'Inspect the target and change records; do not automatically repeat the write.'
        : 'Check D1 access before making a new call.',
      write ? 'unknown' : 'not_applied',
    )
    let response: Response
    let body: unknown
    try {
      response = await this.#fetch(this.#url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.#token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ batch }),
        signal: AbortSignal.timeout(30_000),
        redirect: 'error',
      })
      body = await response.json()
    } catch {
      throw failure
    }
    if (typeof body !== 'object' || body === null || !('success' in body)) throw failure
    if (!response.ok || body.success !== true) {
      const messages =
        'errors' in body && Array.isArray(body.errors)
          ? body.errors
              .map((error: unknown) =>
                typeof error === 'object' &&
                error !== null &&
                'message' in error &&
                typeof error.message === 'string'
                  ? error.message
                  : '',
              )
              .join('\n')
          : ''
      if (
        body.success === false &&
        /CHECK constraint failed: fin_snapshot_current\b/.test(messages)
      )
        throw new FinError(
          'CONFLICT',
          'The Vault changed before the commit.',
          'Read current state, reconsider the operation, and make a new call.',
        )
      if (
        body.success === false &&
        (/SQLITE_(CONSTRAINT|ERROR)\b/.test(messages) || [401, 403, 404].includes(response.status))
      )
        throw new FinError(
          'STORAGE_FAILURE',
          'D1 rejected the storage operation.',
          'Check database access and integrity before making a new call.',
        )
      throw failure
    }
    if (!('result' in body) || !Array.isArray(body.result) || body.result.length !== queries.length)
      throw failure
    return body.result.map((result: unknown) => {
      if (
        typeof result !== 'object' ||
        result === null ||
        !('success' in result) ||
        result.success !== true ||
        !('results' in result)
      )
        throw failure
      if (
        'meta' in result &&
        typeof result.meta === 'object' &&
        result.meta !== null &&
        'served_by_primary' in result.meta &&
        result.meta.served_by_primary === false
      )
        throw failure
      const data: unknown = result.results
      if (
        typeof data !== 'object' ||
        data === null ||
        !('rows' in data) ||
        !Array.isArray(data.rows) ||
        !('columns' in data) ||
        !Array.isArray(data.columns) ||
        !data.columns.every((column: unknown) => typeof column === 'string')
      )
        throw failure
      const rows: unknown[] = data.rows
      if (!rows.every((row): row is unknown[] => Array.isArray(row))) throw failure
      const columns = data.columns.length
      if (
        !rows.every(
          (row) =>
            row.length === columns &&
            row.every(
              (value) =>
                value === null ||
                typeof value === 'string' ||
                (typeof value === 'number' && Number.isFinite(value)),
            ),
        )
      )
        throw failure
      return rows
    })
  }

  async #checkSchema() {
    const [rows] = await this.#request([
      {
        sql: "SELECT name FROM sqlite_master WHERE type IN ('table','view') AND substr(name,1,4)='fin_'",
        params: [],
      },
    ])
    const names = (rows ?? []).map((row) => row[0])
    if (!names.length) return false
    const tables = [
      schema.migrations,
      schema.vaults,
      schema.settings,
      schema.accounts,
      schema.categories,
      schema.transactions,
      schema.assignments,
      schema.relations,
      schema.history,
    ]
    const incompatible = new FinError(
      'SCHEMA_INCOMPATIBLE',
      'The fin schema is incomplete or incompatible.',
      'Prepare a compatible schema explicitly; do not overwrite existing financial data.',
    )
    if (
      !names.includes('fin_category_paths') ||
      !names.includes('fin_commit_guards') ||
      tables.some((table) => !names.includes(getTableName(table)))
    )
      throw incompatible
    const columns = await this.#request(
      tables.map((table) => ({ sql: `PRAGMA table_info("${getTableName(table)}")`, params: [] })),
    )
    for (let index = 0; index < tables.length; index++) {
      const table = tables[index]
      if (
        !table ||
        Object.values(getTableColumns(table)).some(
          (column) => !columns[index]?.some((row) => row[1] === column.name),
        )
      )
        throw incompatible
    }
    const ledger = await this.#orm.select().from(schema.migrations).all()
    if (
      ledger.length !== 1 ||
      ledger[0]?.version !== 1 ||
      ledger[0].identity !== schema.initialMigration
    )
      throw incompatible
    return true
  }

  async #prepare(allowMigrate: boolean) {
    if (this.#deciding)
      throw new FinError(
        'INVALID_INPUT',
        'Storage calls cannot be nested in a mutation decision.',
        'Keep decisions synchronous and free of storage calls.',
      )
    if (!this.#preparing) {
      this.#preparing = (async () => {
        if (await this.#checkSchema()) return
        if (!allowMigrate)
          throw new FinError(
            'SCHEMA_INCOMPATIBLE',
            'The fin schema has not been prepared.',
            'Call storage.migrate() before using fin.',
          )
        const queries: { sql: string; params: unknown[] }[] = schema.initialMigration
          .split(';')
          .map((sql) => sql.trim())
          .filter(Boolean)
          .map((sql) => ({ sql, params: [] }))
        queries.push({
          sql: 'CREATE TABLE fin_migrations (version INTEGER PRIMARY KEY, identity TEXT NOT NULL)',
          params: [],
        })
        queries.push({
          sql: 'INSERT INTO fin_migrations (version, identity) VALUES (1, ?)',
          params: [schema.initialMigration],
        })
        try {
          await this.#request(queries, true)
        } catch (error) {
          // A competing initializer may have committed the complete schema.
          // Inspect it after confirmed rejection; never replay migration writes.
          if (
            !(error instanceof FinError) ||
            error.code !== 'STORAGE_FAILURE' ||
            !(await this.#checkSchema())
          )
            throw error
        }
        await this.#checkSchema()
      })().catch((error: unknown) => {
        this.#preparing = undefined
        throw error
      })
    }
    await this.#preparing
  }

  #raise(error: unknown): never {
    let cause: unknown = error
    while (cause instanceof Error) {
      if (cause instanceof FinError) throw cause
      if (!cause.cause) break
      cause = cause.cause
    }
    throw new FinError(
      'STORAGE_FAILURE',
      'D1 storage could not process the stored data.',
      'Ask the host to inspect schema and data integrity.',
    )
  }

  async migrate() {
    try {
      await this.#prepare(true)
    } catch (error) {
      this.#raise(error)
    }
  }

  async #context(request: ReadRequest | MutationRequest) {
    await this.#prepare(this.#autoMigrate)
    if (request.kind === 'createVault' || request.kind === 'vaults')
      return { context: await readContext(this.#orm, request), stamp: undefined }
    const before = (
      await this.#orm
        .select({
          generation: schema.vaults.generation,
          stamp: sql<string>`cast(${schema.vaults.stamp} as text)`,
        })
        .from(schema.vaults)
        .where(eq(schema.vaults.id, request.vaultId))
        .all()
    )[0]
    let observed: { context: DomainContext } | { error: unknown }
    try {
      observed = { context: await readContext(this.#orm, request) }
    } catch (error) {
      observed = { error }
    }
    const after = (
      await this.#orm
        .select({
          generation: schema.vaults.generation,
          stamp: sql<string>`cast(${schema.vaults.stamp} as text)`,
        })
        .from(schema.vaults)
        .where(eq(schema.vaults.id, request.vaultId))
        .all()
    )[0]
    // All reads use the primary REST path. A monotonic stamp and generation
    // protect the entire bounded projection, including no-ops/product errors.
    if (before?.generation !== after?.generation || before?.stamp !== after?.stamp)
      throw new FinError(
        'CONFLICT',
        'The Vault changed while its context was being read.',
        'Read current state and reconsider the operation before making a new call.',
      )
    if ('error' in observed) throw observed.error
    return { context: observed.context, stamp: after }
  }

  async read(request: ReadRequest) {
    try {
      return (await this.#context(request)).context
    } catch (error) {
      this.#raise(error)
    }
  }

  async mutate<T>(
    request: MutationRequest,
    decide: (context: Readonly<DomainContext>) => MutationDecision<T>,
  ): Promise<T> {
    try {
      const { context, stamp } = await this.#context(request)
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
          'Return a pure synchronous decision without I/O.',
        )
      if (decision.kind === 'unchanged') return decision.result
      const queries = planChanges(this.#orm, request, decision.changes, decision.record)
      if (request.kind !== 'createVault') {
        const guardId = crypto.randomUUID()
        queries.unshift({
          sql: 'INSERT INTO fin_commit_guards (id,ok) VALUES (?, CASE WHEN EXISTS (SELECT 1 FROM fin_vaults WHERE id=? AND generation=? AND stamp=?) THEN 1 ELSE 0 END)',
          params: [guardId, request.vaultId, stamp?.generation ?? '', stamp?.stamp ?? -1],
        })
        queries.push({ sql: 'DELETE FROM fin_commit_guards WHERE id=?', params: [guardId] })
      }
      await this.#request(queries, true)
      return decision.result
    } catch (error) {
      this.#raise(error)
    }
  }
}
