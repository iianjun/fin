import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { DatabaseError, neonConfig } from '@neondatabase/serverless'
import { createNeonAdapter } from './index.js'

const driver = vi.hoisted(() => {
  const session: {
    Client?: typeof import('@neondatabase/serverless').Client
  } = {}
  return {
    query: vi.fn<(sql: string) => Promise<{ command: string }>>(),
    release: vi.fn(),
    end: vi.fn(),
    poolEnd: vi.fn(),
    connect: vi.fn(),
    session,
  }
})
vi.mock('@neondatabase/serverless', async (importOriginal) => {
  const original = await importOriginal<typeof import('@neondatabase/serverless')>()
  return {
    ...original,
    Pool: class {
      set Client(value: typeof original.Client) {
        driver.session.Client = value
      }
      on() {}
      connect = driver.connect
      end = driver.poolEnd
    },
  }
})
vi.mock('./schema.js', () => ({ prepareSchema: async () => {} }))
vi.mock('./storage.js', () => ({
  readContext: async () => ({
    vault: null,
    vaults: [],
    settings: null,
    accounts: [],
    categories: [],
    transactions: [],
    records: [],
  }),
  writeChanges: async () => {},
}))
beforeEach(() => {
  vi.resetAllMocks()
  driver.query.mockImplementation(async (sql) => ({ command: sql.split(' ')[0] ?? '' }))
  driver.connect.mockResolvedValue({
    on() {},
    removeListener() {},
    query: driver.query,
    release: driver.release,
    end: driver.end,
  })
  driver.poolEnd.mockResolvedValue(undefined)
})
const adapters: ReturnType<typeof createNeonAdapter>[] = []
afterEach(async () => {
  for (const storage of adapters.splice(0)) await storage.close()
})

test.each(['rollback-fails', 'release-fails', 'malformed-ack'])(
  'preserves commit uncertainty when %s',
  async (fault) => {
    const storage = createNeonAdapter({
      connectionString: 'postgres://private:secret@host/test',
    })
    adapters.push(storage)
    let decisions = 0
    driver.query.mockImplementation(async (sql) => {
      if (sql === 'COMMIT') {
        if (fault === 'malformed-ack') return { command: '' }
        throw new Error('private transport credentials')
      }
      if (sql === 'ROLLBACK' && fault === 'rollback-fails') throw new Error('private rollback')
      return { command: sql.split(' ')[0] ?? '' }
    })
    if (fault === 'release-fails')
      driver.release.mockImplementation(() => {
        throw new Error('cleanup')
      })
    await expect(
      storage.mutate({ kind: 'createVault' }, () => {
        decisions++
        return { kind: 'unchanged', result: null }
      }),
    ).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN', application: 'unknown' })
    expect(decisions).toBe(1)
    expect(driver.query.mock.calls.filter(([sql]) => sql === 'COMMIT')).toHaveLength(1)
    expect(driver.release).toHaveBeenCalledWith(true)
    if (fault === 'release-fails') expect(driver.end).toHaveBeenCalledOnce()
  },
)

test('cleanup failure cannot replace an acknowledged result', async () => {
  const storage = createNeonAdapter({ connectionString: 'postgres://host/test' })
  adapters.push(storage)
  driver.release.mockImplementation(() => {
    throw new Error('private cleanup')
  })
  expect(
    await storage.mutate({ kind: 'createVault' }, () => ({ kind: 'unchanged', result: 'known' })),
  ).toBe('known')
  expect(driver.end).toHaveBeenCalledOnce()
})

test('server-confirmed commit rejection remains a conflict even when rollback fails', async () => {
  const storage = createNeonAdapter({ connectionString: 'postgres://host/test' })
  adapters.push(storage)
  const rejected = new DatabaseError('private server details', 0, 'error')
  rejected.code = '40001'
  driver.query.mockImplementation(async (sql) => {
    if (sql === 'COMMIT') throw rejected
    if (sql === 'ROLLBACK') throw new Error('cleanup disconnect')
    return { command: sql.split(' ')[0] ?? '' }
  })
  await expect(
    storage.mutate({ kind: 'createVault' }, () => ({ kind: 'unchanged', result: null })),
  ).rejects.toMatchObject({ code: 'CONFLICT', application: 'not_applied' })
})

test('pre-submission connection failures are sanitized and never invoke the decision', async () => {
  const storage = createNeonAdapter({ connectionString: 'postgres://host/test' })
  adapters.push(storage)
  driver.connect.mockRejectedValue(new Error('postgres://private:secret@host SQL text'))
  const decide = vi.fn(() => ({ kind: 'unchanged' as const, result: null }))
  await expect(storage.mutate({ kind: 'createVault' }, decide)).rejects.toMatchObject({
    code: 'STORAGE_FAILURE',
    application: 'not_applied',
    message: 'The Neon operation failed.',
  })
  expect(decide).not.toHaveBeenCalled()
})

test('statement_completion_unknown is not mistaken for confirmed transaction rollback', async () => {
  const storage = createNeonAdapter({ connectionString: 'postgres://host/test' })
  adapters.push(storage)
  const uncertain = new DatabaseError('private server details', 0, 'error')
  uncertain.code = '40003'
  driver.query.mockImplementation(async (sql) => {
    if (sql === 'COMMIT') throw uncertain
    return { command: sql.split(' ')[0] ?? '' }
  })
  await expect(
    storage.mutate({ kind: 'createVault' }, () => ({ kind: 'unchanged', result: null })),
  ).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN', application: 'unknown' })
})

test('owns native WebSocket readiness and encryption settings without changing global driver options', async () => {
  const previous = {
    pipelineConnect: neonConfig.pipelineConnect,
    useSecureWebSocket: neonConfig.useSecureWebSocket,
    forceDisablePgSSL: neonConfig.forceDisablePgSSL,
    wsProxy: neonConfig.wsProxy,
    poolQueryViaFetch: neonConfig.poolQueryViaFetch,
  }
  try {
    neonConfig.pipelineConnect = 'password'
    neonConfig.useSecureWebSocket = false
    neonConfig.forceDisablePgSSL = false
    neonConfig.wsProxy = 'unrelated.invalid'
    neonConfig.poolQueryViaFetch = true
    const storage = createNeonAdapter({ connectionString: 'postgres://user:secret@host/test' })
    adapters.push(storage)
    const Session = driver.session.Client
    if (!Session) throw new Error('Pool must own the Neon session constructor')
    const client = new Session({ connectionString: 'postgres://user:secret@host/test' })
    client.emit('end')
    expect(client.neonConfig.webSocketConstructor).toBe(globalThis.WebSocket)
    expect(client.neonConfig.pipelineConnect).toBe(false)
    expect(client.neonConfig.useSecureWebSocket).toBe(true)
    expect(client.neonConfig.forceDisablePgSSL).toBe(true)
    expect(client.neonConfig.wsProxyAddrForHost('endpoint.neon.tech', 5432)).toBe(
      'endpoint.neon.tech/v2',
    )
    expect(neonConfig.useSecureWebSocket).toBe(false)
    expect(neonConfig.wsProxy).toBe('unrelated.invalid')
    expect(driver.connect).not.toHaveBeenCalled()
    await storage.read({ kind: 'vaults' })
    expect(driver.connect).toHaveBeenCalledOnce()
    expect(driver.query.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
      'SET LOCAL search_path = public, pg_catalog',
      'COMMIT',
    ])
  } finally {
    Object.assign(neonConfig, previous)
  }
})

test('treats a client-side commit timeout as unknown even if cleanup could succeed', async () => {
  const storage = createNeonAdapter({ connectionString: 'postgres://host/test' })
  adapters.push(storage)
  driver.query.mockImplementation(async (sql) => {
    if (sql === 'COMMIT') throw new Error('Query read timeout')
    return { command: sql.split(' ')[0] ?? '' }
  })
  const decide = vi.fn(() => ({ kind: 'unchanged' as const, result: null }))
  await expect(storage.mutate({ kind: 'createVault' }, decide)).rejects.toMatchObject({
    code: 'OUTCOME_UNKNOWN',
    application: 'unknown',
  })
  expect(decide).toHaveBeenCalledOnce()
  expect(driver.release).toHaveBeenCalledWith(true)
  expect(driver.query.mock.calls.filter(([sql]) => sql === 'COMMIT')).toHaveLength(1)
})

test('close waits for actual session end even after pool bookkeeping has completed', async () => {
  const storage = createNeonAdapter({ connectionString: 'postgres://host/test' })
  adapters.push(storage)
  const Session = driver.session.Client
  if (!Session) throw new Error('Missing owned session lifecycle')
  const client = new Session({ connectionString: 'postgres://host/test' })
  let closed = false
  const pending = storage.close().then(() => {
    closed = true
  })
  await Promise.resolve()
  await Promise.resolve()
  expect(driver.poolEnd).toHaveBeenCalledOnce()
  expect(closed).toBe(false)
  client.emit('end')
  await pending
  expect(closed).toBe(true)
})
