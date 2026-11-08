import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { TursoProtocol } from '../src/protocol.js'
import { createTursoAdapter, type TursoAdapterOptions } from '../src/adapter.js'

// Supplemental SQL integration only: SQLite executes real SQL/transactions,
// while this peer emulates v3 envelopes. It cannot prove hosted Turso behavior.
export function openTursoFixture(options: Partial<TursoAdapterOptions> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'fin-turso-'))
  const filename = join(directory, 'test.sqlite')
  const database = new DatabaseSync(filename)
  const streams = new Map<string, DatabaseSync>()
  const storages: ReturnType<typeof createTursoAdapter>[] = []
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
        stmt: z.object({ sql: z.string(), args: z.array(value).optional() }).optional(),
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
        else if (r.type === 'execute' && r.stmt) {
          const sql = r.stmt.sql
          const args = (r.stmt.args ?? []).map((v) =>
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
          results.push({
            type: 'ok',
            response: {
              type: r.type,
              result: {
                cols,
                rows,
                affected_row_count: changes,
                last_insert_rowid: rowid === null ? null : String(rowid),
                rows_read: rows.length,
                rows_written: changes,
                query_duration_ms: 0,
              },
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
  const settings = { url: 'https://db.invalid', authToken: 'unused', fetch, ...options }
  const probe = new TursoProtocol(settings)
  const storage = createTursoAdapter(settings)
  storages.push(storage)
  return {
    storage,
    database,
    fetch,
    settings,
    submissions,
    probe,
    client(extra: Partial<TursoAdapterOptions> = {}) {
      const other = createTursoAdapter({ ...settings, ...extra })
      storages.push(other)
      return other
    },
    async dispose() {
      await Promise.all(storages.map((s) => s.close()))
      await probe.close()
      for (const db of streams.values()) db.close()
      database.close()
      rmSync(directory, { recursive: true, force: true })
    },
  }
}
