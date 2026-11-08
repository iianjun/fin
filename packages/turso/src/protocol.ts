import { FinError } from '@fin/provider'

export type SqlValue = null | string | number | bigint | Uint8Array
export type SqlResult = {
  columns: (string | null)[]
  rows: SqlValue[][]
  affectedRows: number
  lastInsertRowid: bigint | null
}
export interface OperationSession {
  execute(sql: string, args?: readonly SqlValue[]): Promise<SqlResult>
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Invalid protocol object')
  return Object.fromEntries(Object.entries(value))
}

function integer(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|-?[1-9][0-9]*)$/.test(value))
    throw new Error('Invalid integer encoding')
  const parsed = BigInt(value)
  if (parsed < -(2n ** 63n) || parsed >= 2n ** 63n) throw new Error('Integer out of range')
  return parsed
}

function encode(value: SqlValue): object {
  if (value === null) return { type: 'null' }
  if (typeof value === 'string') return { type: 'text', value }
  if (typeof value === 'bigint')
    return { type: 'integer', value: integer(String(value)).toString() }
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (Number.isInteger(value)) {
      if (!Number.isSafeInteger(value)) throw new Error('Unsafe integer input')
      return { type: 'integer', value: String(value) }
    }
    return { type: 'float', value }
  }
  if (value instanceof Uint8Array)
    return { type: 'blob', base64: Buffer.from(value).toString('base64') }
  throw new Error('Invalid SQL input')
}

function decode(value: unknown): SqlValue {
  const v = object(value)
  switch (v.type) {
    case 'null':
      return null
    case 'text':
      if (typeof v.value === 'string') return v.value
      break
    case 'integer':
      // Never convert protocol integers to Number implicitly. Financial projections
      // validate their safe-number domain boundary in storage.ts.
      return integer(v.value)
    case 'float':
      if (
        typeof v.value === 'number' &&
        Number.isFinite(v.value) &&
        (!Number.isInteger(v.value) || Number.isSafeInteger(v.value))
      )
        return v.value
      // The wire permits null for non-finite floats; fin deliberately rejects it.
      break
    case 'blob': {
      if (typeof v.base64 !== 'string') break
      const bytes = Buffer.from(v.base64, 'base64')
      if (
        bytes.toString('base64').replace(/=+$/, '') !== v.base64.replace(/=+$/, '') ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}(?:==)?|[A-Za-z0-9+/]{3}=?)?$/.test(v.base64)
      )
        break
      return new Uint8Array(bytes)
    }
  }
  throw new Error('Invalid SQL value')
}

function statement(value: unknown): SqlResult {
  const v = object(value)
  if (
    !Array.isArray(v.cols) ||
    !Array.isArray(v.rows) ||
    !Number.isSafeInteger(v.affected_row_count) ||
    typeof v.affected_row_count !== 'number' ||
    v.affected_row_count < 0 ||
    !Number.isSafeInteger(v.rows_read) ||
    typeof v.rows_read !== 'number' ||
    v.rows_read < 0 ||
    !Number.isSafeInteger(v.rows_written) ||
    typeof v.rows_written !== 'number' ||
    v.rows_written < 0 ||
    typeof v.query_duration_ms !== 'number' ||
    !Number.isFinite(v.query_duration_ms) ||
    v.query_duration_ms < 0
  )
    throw new Error('Incomplete statement result')
  const columns = v.cols.map((col: unknown) => {
    const c = object(col)
    if (
      (typeof c.name !== 'string' && c.name !== null) ||
      (typeof c.decltype !== 'string' && c.decltype !== null)
    )
      throw new Error('Invalid column')
    return c.name
  })
  return {
    columns,
    rows: v.rows.map((row: unknown) => {
      if (!Array.isArray(row) || row.length !== columns.length) throw new Error('Invalid row width')
      return row.map(decode)
    }),
    affectedRows: v.affected_row_count,
    lastInsertRowid: v.last_insert_rowid === null ? null : integer(v.last_insert_rowid),
  }
}

function origin(value: string): string {
  const url = new URL(value)
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('Expected HTTPS origin')
  return url.origin
}

// One instance belongs exclusively to one admitted operation. No batching,
// sequence, stored SQL or cursor path can hide an unvalidated statement/commit.
class Stream implements OperationSession {
  private baton: string | null = null
  private url: string
  private phase: 'setup' | 'active' | 'commit-submitted' | 'committed' | 'ended' = 'setup'
  private poisoned = false
  private pending: Promise<SqlResult[]> | undefined

  constructor(
    private readonly options: {
      url: string
      authToken: string
      origins: Set<string>
      timeoutMs: number
      fetch: typeof fetch
    },
  ) {
    this.url = options.url
  }

  private async pipeline(
    requests: Record<string, unknown>[],
    autocommit: boolean,
    retain: boolean,
  ): Promise<SqlResult[]> {
    if (this.pending) throw new Error('Concurrent stream requests are forbidden')
    const controller = new AbortController()
    const baton = this.baton
    this.baton = null // A submitted request consumes the old baton even on failure.
    let timer: ReturnType<typeof setTimeout> | undefined
    const work = (async () => {
      const response = await this.options.fetch(`${this.url}/v3/pipeline`, {
        method: 'POST',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${this.options.authToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ baton, requests }),
      })
      if (response.status !== 200 || response.redirected) throw new Error('HTTP request failed')
      const body: unknown = await response.json()
      if (controller.signal.aborted) throw new Error('Expired response')
      const v = object(body)
      if (
        (v.baton !== null && (typeof v.baton !== 'string' || v.baton.length === 0)) ||
        (v.base_url !== null && typeof v.base_url !== 'string') ||
        !Array.isArray(v.results) ||
        v.results.length !== requests.length
      )
        throw new Error('Incomplete pipeline')
      // A newly received baton can release the stream even if the remaining
      // envelope is malformed. Never fall back to a consumed previous baton.
      this.baton = v.baton
      if (v.base_url !== null) {
        const nextBaton = this.baton
        this.baton = null
        const next = origin(v.base_url)
        if (!this.options.origins.has(next)) {
          throw new Error('Untrusted next-request route')
        }
        this.url = next
        this.baton = nextBaton
      }
      if (retain && this.baton === null) throw new Error('Operation stream disappeared')
      const results: SqlResult[] = []
      for (let i = 0; i < requests.length; i++) {
        const result = object(v.results[i])
        if (result.type === 'error') {
          const error = object(result.error)
          if (
            typeof error.message !== 'string' ||
            typeof error.code !== 'string' ||
            !error.code ||
            (error.extended_code !== undefined && typeof error.extended_code !== 'string')
          )
            throw new Error('Malformed statement error')
          // Validate codes but never expose server SQL/data/messages or infer a
          // conflict from an unverified hosted-engine error-code analogy.
          throw new Error('SQL request rejected')
        }
        const r = object(result.response)
        const expected = requests[i]?.type
        if (result.type !== 'ok' || r.type !== expected) throw new Error('Mismatched result')
        if (expected === 'execute') results.push(statement(r.result))
        else if (expected === 'get_autocommit' && r.is_autocommit !== autocommit)
          throw new Error('Unexpected transaction state')
        else if (expected === 'close' && this.baton !== null)
          throw new Error('Stream did not close')
      }
      return results
    })()
    // Bound both headers and body consumption, including injected fetches that
    // neglect AbortSignal. An abort is never evidence of non-application.
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new Error('Request timed out'))
      }, this.options.timeoutMs)
    })
    this.pending = Promise.race([work, timeout])
    try {
      return await this.pending
    } catch {
      this.poisoned = true
      throw this.failure()
    } finally {
      clearTimeout(timer)
      this.pending = undefined
    }
  }

  private failure(): FinError {
    if (this.phase === 'commit-submitted')
      return new FinError(
        'OUTCOME_UNKNOWN',
        'Turso commit acknowledgement was not verified.',
        'Inspect persisted state and Change Records before deciding whether to submit a new operation.',
        'unknown',
      )
    return new FinError(
      'STORAGE_FAILURE',
      'Turso operation failed before commit.',
      'Check connection, engine compatibility and operation state before trying a new operation.',
    )
  }

  async begin(): Promise<void> {
    await this.pipeline(
      [
        { type: 'execute', stmt: { sql: 'PRAGMA foreign_keys = ON', want_rows: true } },
        { type: 'execute', stmt: { sql: 'PRAGMA foreign_keys', want_rows: true } },
        { type: 'get_autocommit' },
      ],
      true,
      true,
    ).then((results) => {
      const setup = results[0]
      const enabled = results[1]
      if (
        !setup ||
        setup.rows.length ||
        setup.columns.length ||
        setup.affectedRows !== 0 ||
        enabled?.columns.length !== 1 ||
        enabled.rows.length !== 1 ||
        enabled.rows[0]?.[0] !== 1n ||
        enabled.affectedRows !== 0
      )
        throw this.failure()
    })
    const results = await this.pipeline(
      [
        { type: 'execute', stmt: { sql: 'BEGIN IMMEDIATE', want_rows: true } },
        { type: 'get_autocommit' },
      ],
      false,
      true,
    )
    if (
      results[0]?.rows.length !== 0 ||
      results[0].columns.length !== 0 ||
      results[0].affectedRows !== 0
    )
      throw this.failure()
    this.phase = 'active'
  }

  async execute(sql: string, args: readonly SqlValue[] = []): Promise<SqlResult> {
    if (this.phase !== 'active' || this.poisoned || this.pending) {
      this.poisoned = true
      throw this.failure()
    }
    let encoded: object[]
    try {
      // This is an internal fin SQL seam, not arbitrary session control. Each
      // execute is one parameterized statement. This narrow seam rejects all
      // semicolons, even inside literals; bind literal text instead of parsing SQL.
      if (
        typeof sql !== 'string' ||
        !/^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|WITH)\b/i.test(sql) ||
        sql.includes(';')
      )
        throw new Error('Invalid operation SQL')
      encoded = args.map(encode)
    } catch {
      this.poisoned = true
      throw new FinError(
        'INVALID_INPUT',
        'Invalid Turso SQL or value.',
        'Use one supported statement and exact SQL values.',
      )
    }
    const results = await this.pipeline(
      [
        { type: 'execute', stmt: { sql, args: encoded, want_rows: true } },
        { type: 'get_autocommit' },
      ],
      false,
      true,
    )
    const result = results[0]
    if (!result) throw this.failure()
    return result
  }

  async commit(): Promise<void> {
    if (this.poisoned || this.pending || this.phase !== 'active') throw this.failure()
    this.phase = 'commit-submitted'
    const results = await this.pipeline(
      [{ type: 'execute', stmt: { sql: 'COMMIT', want_rows: true } }, { type: 'get_autocommit' }],
      true,
      false,
    )
    const receipt = results[0]
    if (
      !receipt ||
      receipt.rows.length !== 0 ||
      receipt.columns.length !== 0 ||
      receipt.affectedRows !== 0
    )
      throw this.failure()
    this.phase = 'committed'
  }

  async release(): Promise<void> {
    // End admission immediately, including callbacks that retained this object.
    const committed = this.phase === 'committed'
    this.phase = 'ended'
    await this.pending?.catch(() => {})
    if (!this.baton) return
    try {
      // close rolls back any open transaction. It cannot retract a commit or
      // resolve commit uncertainty; its response never replaces the outcome.
      await this.pipeline([{ type: 'close' }], true, false)
    } catch {
      /* bounded best-effort release; server expiry remains a fallback */
    } finally {
      this.baton = null
      this.phase = committed ? 'committed' : 'ended'
    }
  }
}

export class TursoProtocol {
  private readonly options: ConstructorParameters<typeof Stream>[0]
  private readonly active = new Set<Promise<unknown>>()
  private closing: Promise<void> | undefined

  constructor(options: {
    url: string
    authToken: string
    allowedRouteOrigins?: readonly string[]
    timeoutMs?: number
    fetch?: typeof fetch
  }) {
    try {
      const url = origin(options.url)
      const timeoutMs = options.timeoutMs ?? 10000
      if (
        typeof options.authToken !== 'string' ||
        !options.authToken.trim() ||
        /[\r\n]/.test(options.authToken) ||
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs < 1 ||
        timeoutMs > 60000 ||
        (options.fetch !== undefined && typeof options.fetch !== 'function')
      )
        throw new Error('Invalid options')
      this.options = {
        url,
        authToken: options.authToken,
        timeoutMs,
        origins: new Set([url, ...(options.allowedRouteOrigins ?? []).map(origin)]),
        fetch: options.fetch ?? globalThis.fetch,
      }
    } catch {
      throw new FinError(
        'INVALID_INPUT',
        'Invalid Turso connection settings.',
        'Supply an HTTPS origin, token and valid transport settings.',
      )
    }
  }

  immediate<T>(operation: (session: OperationSession) => Promise<T>): Promise<T> {
    if (this.closing)
      return Promise.reject(
        new FinError('STORAGE_FAILURE', 'Turso transport is closed.', 'Create a new transport.'),
      )
    const stream = new Stream(this.options)
    const work = (async () => {
      try {
        await stream.begin()
        // Expose only the statement capability at runtime as well as in types;
        // JS callers must not receive begin/commit/release phase controls.
        const result = await operation({ execute: (sql, args) => stream.execute(sql, args) })
        await stream.commit()
        return result
      } finally {
        await stream.release()
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
