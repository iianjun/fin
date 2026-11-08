import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { TursoSessions } from '../src/session.js'
import { createTursoAdapter, type TursoAdapterOptions } from '../src/adapter.js'

const peers = new Map<string, typeof globalThis.fetch>()
const nativeFetch = globalThis.fetch
// Test-only dispatch: the real SDK runs unchanged; production never replaces fetch.
globalThis.fetch = (input, init) => {
  const url = input instanceof Request ? input.url : String(input)
  return (peers.get(new URL(url).origin) ?? nativeFetch)(input, init)
}

export function registerSdkPeer(fetch: typeof globalThis.fetch, authToken = 'unused') {
  const url = `https://${crypto.randomUUID()}.invalid`
  peers.set(url, fetch)
  return { settings: { url, authToken }, dispose: () => peers.delete(url) }
}

type FixtureOptions = Partial<TursoAdapterOptions> & { fetch?: typeof globalThis.fetch }

// Supplemental SQL integration only: SQLite executes real SQL/transactions,
// while this peer emulates v3 envelopes. It cannot prove hosted Turso behavior.
export function openTursoFixture(options: FixtureOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'fin-turso-'))
  const filename = join(directory, 'test.sqlite')
  const database = new DatabaseSync(filename)
  const streams = new Map<string, DatabaseSync>()
  const storages: ReturnType<typeof createTursoAdapter>[] = []
  const registrations: ReturnType<typeof registerSdkPeer>[] = []
  const submissions: { sql: string; args: unknown[]; baton: string }[] = []
  let serial = 0
  const value = z.discriminatedUnion('type', [
    z.object({ type: z.literal('null') }),
    z.object({ type: z.literal('integer'), value: z.string() }),
    z.object({ type: z.literal('text'), value: z.string() }),
    z.object({ type: z.literal('float'), value: z.number() }),
    z.object({ type: z.literal('blob'), base64: z.string() }),
  ])
  const request = z.object({
    baton: z.string().nullable(),
    requests: z.array(
      z.object({
        type: z.string(),
        batch: z
          .object({
            steps: z.array(
              z.object({ stmt: z.object({ sql: z.string(), args: z.array(value).optional() }) }),
            ),
          })
          .optional(),
      }),
    ),
  })
  const fetch: typeof globalThis.fetch = async (_, init) => {
    const parsed: unknown = JSON.parse(String(init?.body))
    const body = request.parse(parsed)
    const baton = body.baton ?? `stream-${++serial}`
    let db = streams.get(baton)
    if (!db) {
      if (body.baton !== null) return new Response('', { status: 404 })
      db = new DatabaseSync(filename, { timeout: 0 })
      streams.set(baton, db)
    }
    const results = []
    for (const r of body.requests) {
      try {
        if (r.type === 'close') {
          db.close()
          streams.delete(baton)
          results.push({ type: 'ok', response: { type: 'close' } })
        } else if (r.type === 'get_autocommit')
          results.push({ type: 'ok', response: { type: r.type, is_autocommit: !db.isTransaction } })
        else if (r.type === 'batch' && r.batch) {
          const stepResults = []
          const stepErrors = []
          for (const step of r.batch.steps) {
            try {
              const sql = step.stmt.sql
              const args = (step.stmt.args ?? []).map((v) =>
                v.type === 'null'
                  ? null
                  : v.type === 'blob'
                    ? Buffer.from(v.base64, 'base64')
                    : v.type === 'integer'
                      ? BigInt(v.value)
                      : v.value,
              )
              submissions.push({ sql, args, baton })
              const stmt = db.prepare(sql)
              stmt.setReadBigInts(true)
              const cols = stmt.columns().map((c) => ({ name: c.name, decltype: c.type }))
              let rows: unknown[][] = []
              let changes = 0
              let rowid: bigint | number | null = null
              if (cols.length)
                rows = stmt.all(...args).map((row) =>
                  cols.map((c) => {
                    const v = row[c.name]
                    if (v === null) return { type: 'null' }
                    if (typeof v === 'bigint') return { type: 'integer', value: String(v) }
                    if (typeof v === 'number') return { type: 'float', value: v }
                    if (typeof v === 'string') return { type: 'text', value: v }
                    if (v instanceof Uint8Array)
                      return { type: 'blob', base64: Buffer.from(v).toString('base64') }
                    throw new Error('Invalid fixture value')
                  }),
                )
              else {
                const info = stmt.run(...args)
                if (/^(INSERT|UPDATE|DELETE)\b/i.test(sql)) {
                  changes = Number(info.changes)
                  rowid = info.lastInsertRowid
                }
              }
              stepResults.push({
                cols,
                rows,
                affected_row_count: changes,
                last_insert_rowid: rowid === null ? null : String(rowid),
                rows_read: rows.length,
                rows_written: changes,
                query_duration_ms: 0,
              })
              stepErrors.push(null)
            } catch {
              stepResults.push(null)
              stepErrors.push({ code: 'TEST_SQL_ERROR', message: 'private fixture SQL error' })
            }
          }
          results.push({
            type: 'ok',
            response: {
              type: 'batch',
              result: { step_results: stepResults, step_errors: stepErrors },
            },
          })
        } else throw new Error('Invalid fixture request')
      } catch {
        results.push({
          type: 'error',
          error: { code: 'TEST_SQL_ERROR', message: 'private fixture SQL error' },
        })
      }
    }
    return Response.json({ baton: streams.has(baton) ? baton : null, base_url: null, results })
  }
  function client(extra: FixtureOptions = {}) {
    const registration = registerSdkPeer(extra.fetch ?? options.fetch ?? fetch)
    registrations.push(registration)
    const other = createTursoAdapter({ ...options, ...extra, ...registration.settings })
    storages.push(other)
    return other
  }
  const registration = registerSdkPeer(fetch)
  registrations.push(registration)
  const settings = { ...registration.settings, ...options }
  const probe = new TursoSessions(settings)
  const storage = client()
  return {
    storage,
    database,
    fetch,
    settings,
    submissions,
    probe,
    client,
    async dispose() {
      await Promise.all(storages.map((s) => s.close()))
      await probe.close()
      for (const db of streams.values()) db.close()
      database.close()
      for (const registered of registrations) registered.dispose()
      rmSync(directory, { recursive: true, force: true })
    },
  }
}
