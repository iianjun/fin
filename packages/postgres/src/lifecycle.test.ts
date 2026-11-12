import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { DatabaseError } from 'pg'
import { createPostgresAdapter } from './index.js'

const driver = vi.hoisted(() => ({
  query: vi.fn<(sql: string) => Promise<{ command: string }>>(),
  release: vi.fn(),
  end: vi.fn(),
  poolEnd: vi.fn(),
  connect: vi.fn(),
}))
vi.mock('pg', async (importOriginal) => {
  const original = await importOriginal<typeof import('pg')>()
  return {
    ...original,
    Pool: class {
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
const adapters: ReturnType<typeof createPostgresAdapter>[] = []
afterEach(async () => {
  for (const storage of adapters.splice(0)) await storage.close()
})

test.each(['rollback-fails', 'release-fails', 'malformed-ack'])(
  'preserves commit uncertainty when %s',
  async (fault) => {
    const storage = createPostgresAdapter({
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
  const storage = createPostgresAdapter({ connectionString: 'postgres://host/test' })
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
  const storage = createPostgresAdapter({ connectionString: 'postgres://host/test' })
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
  const storage = createPostgresAdapter({ connectionString: 'postgres://host/test' })
  adapters.push(storage)
  driver.connect.mockRejectedValue(new Error('postgres://private:secret@host SQL text'))
  const decide = vi.fn(() => ({ kind: 'unchanged' as const, result: null }))
  await expect(storage.mutate({ kind: 'createVault' }, decide)).rejects.toMatchObject({
    code: 'STORAGE_FAILURE',
    application: 'not_applied',
    message: 'The PostgreSQL operation failed.',
  })
  expect(decide).not.toHaveBeenCalled()
})

test('statement_completion_unknown is not mistaken for confirmed transaction rollback', async () => {
  const storage = createPostgresAdapter({ connectionString: 'postgres://host/test' })
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
