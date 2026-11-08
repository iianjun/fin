import { expect, test, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { FinError } from '@fin/provider'
import { TursoProtocol, type OperationSession } from './protocol.js'

function result(rows: unknown[][] = [], names: string[] = []) {
  return {
    cols: names.map((name) => ({ name, decltype: null })),
    rows,
    affected_row_count: 0,
    last_insert_rowid: null,
    rows_read: rows.length,
    rows_written: 0,
    query_duration_ms: 0,
  }
}

// A deterministic protocol peer, not an engine emulator. Mutations below alter
// the wire response; none of these tests establishes SQL/isolation conformance.
function peer(change?: (body: any, sql: string[], call: number) => Response | void) {
  let call = 0
  const submissions: { sql: string[]; baton: unknown; url: string; init: RequestInit }[] = []
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    const request = JSON.parse(String(init?.body))
    const sql = request.requests
      .filter((r: any) => r.type === 'execute')
      .map((r: any) => r.stmt.sql)
    const closing = request.requests[0].type === 'close'
    const committing = sql.includes('COMMIT')
    call++
    submissions.push({ sql, baton: request.baton, url: String(url), init: init ?? {} })
    const body = {
      baton: closing ? null : `baton-${call}`,
      base_url: null,
      results: request.requests.map((r: any) => ({
        type: 'ok',
        response: {
          type: r.type,
          ...(r.type === 'execute'
            ? {
                result:
                  r.stmt.sql === 'PRAGMA foreign_keys'
                    ? result([[{ type: 'integer', value: '1' }]], ['foreign_keys'])
                    : result(),
              }
            : {}),
          ...(r.type === 'get_autocommit'
            ? { is_autocommit: sql[0]?.startsWith('PRAGMA') || committing }
            : {}),
        },
      })),
    }
    return change?.(body, sql, call) ?? Response.json(body)
  })
  const transport = new TursoProtocol({ url: 'https://db.invalid', authToken: 'secret', fetch })
  return { transport, fetch, submissions }
}

test('lazy options, sanitized validation, and idempotent unused close', async () => {
  const p = peer()
  expect(p.fetch).not.toHaveBeenCalled()
  const close = p.transport.close()
  expect(p.transport.close()).toBe(close)
  await close
  expect(p.fetch).not.toHaveBeenCalled()
  await expect(p.transport.immediate(async () => 0)).rejects.toMatchObject({
    code: 'STORAGE_FAILURE',
  })
  for (const url of [
    'http://db.invalid',
    'libsql://db.invalid',
    'https://x:secret@db.invalid',
    'https://db.invalid/path',
    'https://db.invalid?token=secret',
  ])
    expect(() => new TursoProtocol({ url, authToken: 'secret' })).toThrow(
      'Invalid Turso connection settings.',
    )
  for (const authToken of ['', 'bad\r\ntoken'])
    expect(() => new TursoProtocol({ url: 'https://db.invalid', authToken })).toThrow(FinError)
})

test('same stream setup before BEGIN, rotating batons, one decision, strict commit and close', async () => {
  const p = peer()
  const decision = vi.fn(() => 17)
  await expect(
    p.transport.immediate(async (tx) => {
      await tx.execute('SELECT 1')
      return decision()
    }),
  ).resolves.toBe(17)
  expect(decision).toHaveBeenCalledTimes(1)
  expect(p.submissions.map((s) => s.sql)).toEqual([
    ['PRAGMA foreign_keys = ON', 'PRAGMA foreign_keys'],
    ['BEGIN IMMEDIATE'],
    ['SELECT 1'],
    ['COMMIT'],
    [],
  ])
  expect(p.submissions.map((s) => s.baton)).toEqual([
    null,
    'baton-1',
    'baton-2',
    'baton-3',
    'baton-4',
  ])
  expect(p.submissions.every((s) => s.init.redirect === 'manual')).toBe(true)
})

test.each([
  [
    'missing results',
    (b: any) => {
      delete b.results
    },
  ],
  [
    'empty results',
    (b: any) => {
      b.results = []
    },
  ],
  [
    'extra result',
    (b: any) => {
      b.results.push(b.results[0])
    },
  ],
  [
    'missing execute',
    (b: any) => {
      b.results[0] = null
    },
  ],
  [
    'wrong type',
    (b: any) => {
      b.results[0].response.type = 'sequence'
    },
  ],
  [
    'autocommit alone',
    (b: any) => {
      b.results[0] = b.results[1]
    },
  ],
  [
    'missing autocommit',
    (b: any) => {
      delete b.results[1].response.is_autocommit
    },
  ],
  [
    'not autocommit',
    (b: any) => {
      b.results[1].response.is_autocommit = false
    },
  ],
  [
    'missing metadata',
    (b: any) => {
      delete b.results[0].response.result.last_insert_rowid
    },
  ],
  [
    'invalid metrics',
    (b: any) => {
      b.results[0].response.result.rows_read = -1
    },
  ],
  [
    'rows in commit',
    (b: any) => {
      b.results[0].response.result = result([[{ type: 'integer', value: '1' }]], ['unexpected'])
    },
  ],
  [
    'missing baton',
    (b: any) => {
      delete b.baton
    },
  ],
  [
    'bad baton',
    (b: any) => {
      b.baton = ''
    },
  ],
  [
    'missing routing',
    (b: any) => {
      delete b.base_url
    },
  ],
  [
    'malformed error',
    (b: any) => {
      b.results[0] = { type: 'error', error: { message: 'secret' } }
    },
  ],
  [
    'known SQL error',
    (b: any) => {
      b.results[0] = { type: 'error', error: { message: 'secret', code: 'SQLITE_BUSY' } }
    },
  ],
])(
  'commit rejects %s without replay and retains uncertainty through cleanup',
  async (_, corrupt) => {
    const p = peer((body, sql) => {
      if (sql.includes('COMMIT')) corrupt(body)
      if (!sql.length) return new Response('cleanup failed', { status: 503 })
    })
    const decision = vi.fn(() => 1)
    const error = await p.transport.immediate(async () => decision()).catch((e) => e)
    expect(error).toMatchObject({ code: 'OUTCOME_UNKNOWN', application: 'unknown' })
    expect(JSON.stringify(error)).not.toContain('secret')
    expect(decision).toHaveBeenCalledTimes(1)
    expect(p.submissions.filter((s) => s.sql.includes('COMMIT'))).toHaveLength(1)
  },
)

test.each([301, 302, 303, 307, 308, 401, 404, 408, 429, 500, 503])(
  'HTTP %s after commit is uncertain, never followed or retried',
  async (status) => {
    const p = peer((_, sql) => {
      if (sql.includes('COMMIT'))
        return new Response('', { status, headers: { location: 'https://evil.invalid' } })
    })
    await expect(p.transport.immediate(async () => 1)).rejects.toMatchObject({
      code: 'OUTCOME_UNKNOWN',
    })
    expect(p.submissions).toHaveLength(3)
  },
)

test.each(['disconnect', 'json', 'truncated', 'body'])(
  'commit %s has one submission, no replay',
  async (fault) => {
    const p = peer((_, sql) => {
      if (sql.includes('COMMIT')) {
        if (fault === 'disconnect') throw new Error('secret network error')
        if (fault === 'body')
          return new Response(
            new ReadableStream({
              start(c) {
                c.error(new Error('secret'))
              },
            }),
          )
        return new Response(fault === 'json' ? 'invalid' : '{"results":[')
      }
    })
    await expect(p.transport.immediate(async () => 1)).rejects.toMatchObject({
      code: 'OUTCOME_UNKNOWN',
    })
    expect(p.submissions).toHaveLength(3)
  },
)

test('unknown response extension fields are ignored per v3, complete null-baton commit succeeds', async () => {
  const p = peer((b, sql) => {
    b.extension = 'future'
    if (sql.includes('COMMIT')) b.baton = null
  })
  await expect(p.transport.immediate(async () => 2)).resolves.toBe(2)
  expect(p.submissions).toHaveLength(3)
})

test.each(['disabled foreign keys', 'missing session baton', 'bad BEGIN', 'autocommit BEGIN'])(
  '%s stops before decision and commit',
  async (fault) => {
    const p = peer((b, sql, call) => {
      if (call === 1 && fault === 'disabled foreign keys')
        b.results[1].response.result.rows[0][0].value = '0'
      if (call === 1 && fault === 'missing session baton') b.baton = null
      if (sql[0] === 'BEGIN IMMEDIATE' && fault === 'bad BEGIN') b.results[0].response.result = {}
      if (sql[0] === 'BEGIN IMMEDIATE' && fault === 'autocommit BEGIN')
        b.results[1].response.is_autocommit = true
    })
    const decision = vi.fn(async () => 1)
    await expect(p.transport.immediate(decision)).rejects.toMatchObject({
      code: 'STORAGE_FAILURE',
      application: 'not_applied',
    })
    expect(decision).not.toHaveBeenCalled()
    expect(p.submissions.some((s) => s.sql.includes('COMMIT'))).toBe(false)
  },
)

test.each([
  { type: 'integer', value: '9007199254740993.0' },
  { type: 'integer', value: 1 },
  { type: 'integer', value: '9223372036854775808' },
  { type: 'integer', value: '01' },
  { type: 'text', value: null },
  { type: 'float', value: null },
  { type: 'float', value: 9007199254740992 },
  { type: 'blob', base64: 'a' },
  { type: 'blob', base64: '!!!!' },
  { type: 'unknown' },
])('malformed value %j never reaches decision or COMMIT', async (value) => {
  const p = peer((b, sql) => {
    if (sql[0] === 'SELECT x') b.results[0].response.result = result([[value]], ['x'])
  })
  const decision = vi.fn()
  await expect(
    p.transport.immediate(async (tx) => {
      await tx.execute('SELECT x')
      decision()
    }),
  ).rejects.toMatchObject({ code: 'STORAGE_FAILURE' })
  expect(decision).not.toHaveBeenCalled()
  expect(p.submissions.some((s) => s.sql.includes('COMMIT'))).toBe(false)
})

test('exact signed int64, text, blob, float and null round trips with no lossy rowid conversion', async () => {
  const values = [
    null,
    '한글\u0000🙂',
    9007199254740991,
    -9223372036854775808n,
    9223372036854775807n,
    1.25,
    new Uint8Array([0, 255]),
  ]
  const p = peer((b, sql) => {
    if (sql[0] === 'SELECT ?') {
      const req = JSON.parse(String(p.submissions.at(-1)?.init.body))
      b.results[0].response.result = {
        ...result(
          [req.requests[0].stmt.args],
          values.map((_, i) => String(i)),
        ),
        last_insert_rowid: '9007199254740993',
      }
    }
  })
  await p.transport.immediate(async (tx) => {
    const r = await tx.execute('SELECT ?', values)
    expect(r.rows).toEqual([
      [null, values[1], 9007199254740991n, values[3], values[4], 1.25, values[6]],
    ])
    expect(r.lastInsertRowid).toBe(9007199254740993n)
  })
})

test.each([Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, 9223372036854775808n])(
  'bad bound value %s is rejected before query submission',
  async (value) => {
    const p = peer()
    await expect(
      p.transport.immediate((tx) => tx.execute('SELECT ?', [value])),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(p.submissions.map((s) => s.sql)).toEqual([
      ['PRAGMA foreign_keys = ON', 'PRAGMA foreign_keys'],
      ['BEGIN IMMEDIATE'],
      [],
    ])
  },
)

test.each([
  'COMMIT',
  'END',
  'ROLLBACK',
  'PRAGMA foreign_keys = OFF',
  '/* bypass */ COMMIT',
  'ATTACH DATABASE x',
  'SELECT 1; COMMIT',
  "SELECT ';'",
])('session SQL %s cannot bypass commit tracking', async (sql) => {
  const p = peer()
  await expect(p.transport.immediate((tx) => tx.execute(sql))).rejects.toMatchObject({
    code: 'INVALID_INPUT',
  })
  expect(p.submissions).toHaveLength(3)
})

test.each([
  'https://evil.invalid',
  'http://db.invalid',
  'https://db.invalid/other',
  'https://user:secret@db.invalid',
  'https://db.invalid?x=y',
])('untrusted route %s never receives credentials or a replay', async (route) => {
  const p = peer((b) => {
    b.base_url = route
  })
  await expect(p.transport.immediate(async () => 1)).rejects.toMatchObject({
    code: 'STORAGE_FAILURE',
  })
  expect(p.submissions).toHaveLength(1)
})

test('explicit trusted next-request routing changes only the next request; baton ordering remains intact', async () => {
  const p = peer((b, _, call) => {
    if (call === 2) b.base_url = 'https://node.invalid'
  })
  const t = new TursoProtocol({
    url: 'https://db.invalid',
    authToken: 'secret',
    allowedRouteOrigins: ['https://node.invalid'],
    fetch: p.fetch,
  })
  await t.immediate((tx) => tx.execute('SELECT 1'))
  expect(p.submissions.map((s) => s.url)).toEqual([
    'https://db.invalid/v3/pipeline',
    'https://db.invalid/v3/pipeline',
    'https://node.invalid/v3/pipeline',
    'https://node.invalid/v3/pipeline',
    'https://node.invalid/v3/pipeline',
  ])
})

test('expired context, missing row width and unexpected autocommit poison swallowed failures', async () => {
  for (const fault of ['expired', 'width', 'autocommit']) {
    const p = peer((b, sql) => {
      if (sql[0] === 'SELECT x') {
        if (fault === 'expired') return new Response('', { status: 404 })
        if (fault === 'width') b.results[0].response.result = result([[]], ['x'])
        if (fault === 'autocommit') b.results[1].response.is_autocommit = true
      }
    })
    await expect(
      p.transport.immediate(async (tx) => {
        await tx.execute('SELECT x').catch(() => {})
      }),
    ).rejects.toMatchObject({ code: 'STORAGE_FAILURE' })
    expect(p.submissions.some((s) => s.sql.includes('COMMIT'))).toBe(false)
  }
})

test('callback failure is preserved even if close fails; committed success survives failed close', async () => {
  const p = peer((_, sql) => {
    if (!sql.length) throw new Error('close failed')
  })
  const domain = new FinError('NOT_FOUND', 'Missing account.', 'Inspect accounts.')
  await expect(
    p.transport.immediate(async () => {
      throw domain
    }),
  ).rejects.toBe(domain)
  await expect(p.transport.immediate(async () => 42)).resolves.toBe(42)
})

test('close drains admitted operations, rejects new admission and prevents retained-session use', async () => {
  const p = peer()
  let resume: (() => void) | undefined
  let session: OperationSession | undefined
  let enteredResolve = () => {}
  const entered = new Promise<void>((resolve) => {
    enteredResolve = resolve
  })
  const work = p.transport.immediate(async (tx) => {
    session = tx
    enteredResolve()
    await new Promise<void>((resolve) => {
      resume = resolve
    })
    return 3
  })
  await entered
  let closed = false
  const close = p.transport.close().then(() => {
    closed = true
  })
  await expect(p.transport.immediate(async () => 1)).rejects.toThrow('closed')
  expect(closed).toBe(false)
  resume?.()
  await expect(work).resolves.toBe(3)
  await close
  await expect(session?.execute('SELECT 1')).rejects.toMatchObject({ code: 'STORAGE_FAILURE' })
})

test('concurrent/abandoned same-stream calls prevent commit, independent operations use distinct streams', async () => {
  const p = peer()
  await expect(
    p.transport.immediate(async (tx) => {
      const first = tx.execute('SELECT 1')
      await tx.execute('SELECT 2').catch(() => {})
      await first
    }),
  ).rejects.toMatchObject({ code: 'STORAGE_FAILURE' })
  await expect(
    p.transport.immediate(async (tx) => {
      void tx.execute('SELECT 1')
    }),
  ).rejects.toMatchObject({ code: 'STORAGE_FAILURE' })
  expect(p.submissions.some((s) => s.sql.includes('COMMIT'))).toBe(false)
  await Promise.all([p.transport.immediate(async () => 1), p.transport.immediate(async () => 2)])
  expect(p.submissions.filter((s) => s.baton === null)).toHaveLength(4)
})

test.each(['headers', 'body'])(
  'bounded %s timeout aborts commit without replay, close drains',
  async (fault) => {
    const p = peer((_, sql) => {
      if (sql.includes('COMMIT')) {
        if (fault === 'body') return new Response(new ReadableStream({ start() {} }))
        // Peer callbacks are synchronous; use a pending body for either variant below.
      }
    })
    let signal: AbortSignal | null | undefined
    const fetch: typeof globalThis.fetch = async (url, init) => {
      if (String(init?.body).includes('COMMIT')) {
        signal = init?.signal
        return fault === 'headers'
          ? new Promise<Response>(() => {})
          : new Response(new ReadableStream({ start() {} }))
      }
      return p.fetch(url, init)
    }
    const t = new TursoProtocol({
      url: 'https://db.invalid',
      authToken: 'secret',
      timeoutMs: 20,
      fetch,
    })
    await expect(t.immediate(async () => 1)).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' })
    expect(signal?.aborted).toBe(true)
    await t.close()
  },
)

test('hosted command fails closed with exit 2 when dedicated credentials are absent', () => {
  const run = spawnSync(process.execPath, ['packages/turso/test/hosted.mjs'], {
    env: {},
    encoding: 'utf8',
    timeout: 10000,
  })
  expect(run.status).toBe(2)
  expect(run.stderr).toContain('hosted verification pending')
  expect(run.stdout).toBe('')
})
