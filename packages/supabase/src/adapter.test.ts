import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { expect, test, vi } from 'vitest'
import { createFin, createVault, FinError } from '@fin/core'
import { createSupabaseAdapter } from './adapter.js'
import { identity } from './context.js'
import type { DomainContext, MutationDecision } from '@fin/provider'

// Deliberate protocol peer: deterministic faults only, never real storage evidence.
function peer(fault?: (name: string, value: Record<string, unknown>) => Response | void) {
  const calls: string[] = []
  const vault = { id: 'v', name: 'Vault', revision: 'r', archived: false }
  const context: DomainContext = {
    vault,
    vaults: [],
    settings: { revision: 's', incomeAccountId: null, expenseAccountId: null },
    accounts: [],
    categories: [],
    transactions: [],
    records: [],
  }
  const transport = vi.fn<typeof fetch>(async (input, init) => {
    const name = new URL(String(input)).pathname.split('/').pop() ?? ''
    const body = JSON.parse(String(init?.body))
    calls.push(name)
    expect(init?.redirect).toBe('manual')
    const headers = new Headers(init?.headers)
    expect(headers.get('apikey')).toBe('sb_secret_test')
    expect(headers.get('X-Client-Info')).toContain('supabase-js/2.119.0')
    expect(headers.has('Authorization')).toBe(false)
    let value: Record<string, unknown>
    if (name === 'fin_supabase_check_schema') value = { identity: identity }
    else if (name === 'fin_supabase_context')
      value = {
        identity: identity,
        nonce: body.p_nonce,
        kind: body.p_request.kind,
        vaultId: body.p_request.vaultId ?? null,
        guard: body.p_request.vaultId ? { generation: 'g', stamp: '9007199254740992' } : null,
        context: body.p_request.vaultId
          ? structuredClone(context)
          : { ...context, vault: null, settings: null },
      }
    else
      value = {
        identity: identity,
        nonce: body.p_nonce,
        vaultId: body.p_record.vaultId,
        recordId: body.p_record.id,
        generation: body.p_guard.generation,
        stamp: (BigInt(body.p_guard.stamp) + 1n).toString(),
      }
    if (name === 'fin_supabase_context')
      value.counts = { vaults: 0, accounts: 0, categories: 0, transactions: 0, records: 0 }
    return fault?.(name, value) ?? Response.json(value)
  })
  const storage = createSupabaseAdapter({
    url: 'https://project.invalid',
    apiKey: 'sb_secret_test',
    fetch: transport,
  })
  return { storage, transport, calls, context }
}

test('validates options synchronously, factory has no I/O, no bootstrap or empty close API', async () => {
  const p = peer()
  expect(p.transport).not.toHaveBeenCalled()
  expect(Object.keys(p.storage).sort()).toEqual(['checkSchema', 'mutate', 'read'])
  for (const options of [
    null,
    {},
    { url: 'https://p.invalid', apiKey: 'publishable' },
    { url: 'http://p.invalid', apiKey: 'sb_secret_test' },
    { url: 'https://u:p@p.invalid', apiKey: 'sb_secret_test' },
    { url: 'https://p.invalid/rest/v1', apiKey: 'sb_secret_test' },
    { url: 'https://p.invalid', apiKey: 'sb_secret_test', timeoutMs: 0 },
    { url: 'https://p.invalid', apiKey: 'sb_secret_test', fetch: 2 },
  ])
    expect(() => createSupabaseAdapter(JSON.parse(JSON.stringify(options)))).toThrowError(
      expect.objectContaining({ code: 'INVALID_INPUT' }),
    )
  for (const [setting, options] of [
    ['url', { url: 'https://secret@p.invalid', apiKey: 'sb_secret_test' }],
    ['apiKey', { url: 'https://p.invalid', apiKey: 'secret-publishable' }],
    ['fetch', { url: 'https://p.invalid', apiKey: 'sb_secret_test', fetch: 'secret' }],
    ['timeoutMs', { url: 'https://p.invalid', apiKey: 'sb_secret_test', timeoutMs: 120001 }],
  ] as const) {
    const error = (() => {
      try {
        createSupabaseAdapter(JSON.parse(JSON.stringify(options)))
      } catch (error) {
        return error
      }
    })()
    expect(error).toMatchObject({ message: `Invalid Supabase adapter ${setting}.` })
    expect(String(error)).not.toContain('secret@')
    expect(String(error)).not.toContain('secret-')
  }
  await p.storage.checkSchema()
  await p.storage.checkSchema()
  expect(p.calls).toEqual(['fin_supabase_check_schema', 'fin_supabase_check_schema'])
})

test('lazy context and complete matching commit receipt, including stamps above safe integer', async () => {
  const p = peer()
  const fin = createFin({ storage: p.storage, vaultId: 'v' })
  const result = await fin.updateVault({ expectedRevision: 'r', patch: { name: 'New' } })
  expect(result.vault.name).toBe('New')
  expect(p.calls).toEqual(['fin_supabase_context', 'fin_supabase_commit'])
})

test.each([
  'identity',
  'nonce',
  'kind',
  'vaultId',
  'guard',
  'context',
  'duplicate',
  'unsafe',
  'dangling',
  'hierarchy',
  'record-scope',
  'incomplete-array',
  'bad-codec',
])('rejects %s context before calling the decision', async (fault) => {
  const p = peer((name, value) => {
    if (name !== 'fin_supabase_context') return
    const context = value.context
    if (!context || typeof context !== 'object') throw new Error('Missing fixture context')
    if (['identity', 'nonce', 'kind', 'vaultId'].includes(fault)) value[fault] = 'wrong'
    if (fault === 'guard') delete value.guard
    if (fault === 'context') delete value.context
    const account = {
      id: 'a',
      revision: 'r',
      balanceRevision: 'b',
      name: 'Cash',
      nature: 'asset',
      currency: 'KRW',
      archived: false,
      hasTransactions: false,
    }
    if (fault === 'duplicate') Object.assign(context, { accounts: [account, account] })
    if (fault === 'unsafe')
      Object.assign(context, {
        accounts: [account],
        transactions: [
          {
            id: 't',
            revision: 'r',
            kind: 'income',
            occurredOn: '2026-11-08',
            memo: null,
            accountId: 'a',
            amountMinor: 9007199254740992,
            assignments: [],
            relations: [],
          },
        ],
      })
    if (fault === 'dangling')
      Object.assign(context, {
        settings: { revision: 's', incomeAccountId: 'missing', expenseAccountId: null },
      })
    if (fault === 'hierarchy')
      Object.assign(context, {
        categories: [{ id: 'c', revision: 'r', name: 'Cycle', parentId: 'c', archived: false }],
      })
    if (fault === 'record-scope')
      Object.assign(context, {
        records: [
          {
            id: 'record',
            vaultId: 'foreign',
            target: 'vault',
            targetId: 'v',
            action: 'created',
            recordedAt: '2026-11-08',
            before: null,
            after: null,
            balances: [],
          },
        ],
      })
    value.counts = Object.fromEntries(
      Object.entries(context)
        .filter(([, v]) => Array.isArray(v))
        .map(([key, v]) => [key, v.length]),
    )
    if (fault === 'incomplete-array')
      value.counts = { vaults: 0, accounts: 1, categories: 0, transactions: 0, records: 0 }
    if (fault === 'bad-codec')
      Object.assign(context, {
        vault: { id: 'v', name: String.raw`bad\x`, revision: 'r', archived: false },
      })
    return Response.json(value)
  })
  const decide = vi.fn(() => ({ kind: 'unchanged', result: 1 }) as const)
  await expect(p.storage.mutate({ kind: 'vault', vaultId: 'v' }, decide)).rejects.toMatchObject({
    code: 'STORAGE_FAILURE',
    application: 'not_applied',
  })
  expect(decide).not.toHaveBeenCalled()
  expect(p.calls).toEqual(['fin_supabase_context'])
})

test('unchanged decisions and domain errors never submit a commit', async () => {
  const p = peer()
  const value = { same: true }
  expect(
    await p.storage.mutate({ kind: 'vault', vaultId: 'v' }, () => ({
      kind: 'unchanged',
      result: value,
    })),
  ).toBe(value)
  const error = new FinError('CONFLICT', 'Domain error', 'Read fresh state')
  await expect(
    p.storage.mutate({ kind: 'vault', vaultId: 'v' }, () => {
      throw error
    }),
  ).rejects.toBe(error)
  expect(p.calls.every((name) => name === 'fin_supabase_context')).toBe(true)
})

test.each(['read', 'mutate', 'checkSchema', 'async'])(
  'rejects %s nested/async decisions and later continuations',
  async (kind) => {
    const p = peer(),
      nested: Promise<unknown>[] = []
    if (kind === 'async') {
      await expect(
        p.storage.mutate(
          { kind: 'vault', vaultId: 'v' },
          // @ts-expect-error Runtime JavaScript can supply an async decision.
          async () => {
            await Promise.resolve()
            nested.push(p.storage.read({ kind: 'vaults' }))
            return { kind: 'unchanged', result: 1 }
          },
        ),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    } else {
      await expect(
        p.storage.mutate({ kind: 'vault', vaultId: 'v' }, () => {
          nested.push(
            kind === 'read'
              ? p.storage.read({ kind: 'vaults' })
              : kind === 'checkSchema'
                ? p.storage.checkSchema()
                : p.storage.mutate({ kind: 'createVault' }, () => ({
                    kind: 'unchanged',
                    result: 1,
                  })),
          )
          return { kind: 'unchanged', result: 1 }
        }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    }
    await Promise.resolve()
    expect(nested).toHaveLength(1)
    await expect(nested[0]).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(p.calls).toEqual(['fin_supabase_context'])
  },
)

test.each([
  'identity',
  'nonce',
  'vaultId',
  'recordId',
  'generation',
  'stamp',
  'missing',
  'truncated',
  'redirect',
  'disconnect',
  'gateway',
  'malformed-error',
  'redirected-response',
  'transport-finerror',
])('%s after commit submission stays uncertain with one decision and no replay', async (fault) => {
  const p = peer((name, value) => {
    if (name !== 'fin_supabase_commit') return
    if (fault === 'transport-finerror')
      throw new FinError('STORAGE_FAILURE', 'Transport guessed rollback', 'Unsafe claim')
    if (fault === 'disconnect') throw new Error('Secret credential must not leak')
    if (fault === 'redirect')
      return new Response(null, { status: 307, headers: { Location: 'https://other.invalid' } })
    if (fault === 'redirected-response') {
      const response = Response.json(value)
      Object.defineProperty(response, 'redirected', { value: true })
      return response
    }
    if (fault === 'gateway')
      return Response.json({ code: 'upstream_failure', message: 'secret' }, { status: 502 })
    if (fault === 'malformed-error')
      return Response.json({ code: 'PT409', message: 'forged incomplete error' }, { status: 409 })
    if (fault === 'truncated') return new Response('{"identity":')
    if (fault === 'missing') delete value.stamp
    else value[fault] = 'wrong'
    return Response.json(value)
  })
  const decide = vi.fn(
    () =>
      ({
        kind: 'changed',
        changes: { vault: p.context.vault ?? undefined },
        record: {
          id: 'r2',
          vaultId: 'v',
          target: 'vault',
          targetId: 'v',
          action: 'updated',
          recordedAt: '2026-11-08',
          before: p.context.vault,
          after: p.context.vault,
          balances: [],
        },
        result: 7,
      }) satisfies MutationDecision<number>,
  )
  await expect(p.storage.mutate({ kind: 'vault', vaultId: 'v' }, decide)).rejects.toMatchObject({
    code: 'OUTCOME_UNKNOWN',
    application: 'unknown',
  })
  expect(decide).toHaveBeenCalledTimes(1)
  expect(p.calls.filter((n) => n === 'fin_supabase_commit')).toHaveLength(1)
})

test.each([
  ['PT409', 409, 'CONFLICT'],
  ['PT412', 412, 'SCHEMA_INCOMPATIBLE'],
  ['23514', 400, 'STORAGE_FAILURE'],
  ['42501', 403, 'STORAGE_FAILURE'],
  ['PGRST202', 404, 'SCHEMA_INCOMPATIBLE'],
])('complete %s rollback/rejection receipt gives confirmed %s', async (code, status, expected) => {
  const p = peer((name) =>
    name === 'fin_supabase_commit'
      ? Response.json(
          { code, message: 'sensitive raw server details', details: null, hint: null },
          { status: Number(status) },
        )
      : undefined,
  )
  const fin = createFin({ storage: p.storage, vaultId: 'v' })
  await expect(
    fin.updateVault({ expectedRevision: 'r', patch: { name: 'New' } }),
  ).rejects.toMatchObject({ code: expected, application: 'not_applied' })
})

test('a duplicate key is a lost creation race only for createVault commits', async () => {
  const p = peer((name) =>
    name === 'fin_supabase_commit'
      ? Response.json(
          { code: '23505', message: 'duplicate', details: null, hint: null },
          { status: 409 },
        )
      : undefined,
  )
  await expect(createVault({ storage: p.storage, name: 'Vault' })).rejects.toMatchObject({
    code: 'CONFLICT',
    application: 'not_applied',
  })
  await expect(
    createFin({ storage: p.storage, vaultId: 'v' }).updateVault({
      expectedRevision: 'r',
      patch: { name: 'New' },
    }),
  ).rejects.toMatchObject({ code: 'STORAGE_FAILURE', application: 'not_applied' })
})

test('pre-commit disconnect is sanitized and no decision runs; unknown error status is not rollback proof', async () => {
  const p = peer(() => {
    throw new Error('sb_secret_sensitive')
  })
  const error = await createVault({ storage: p.storage, name: 'Vault' }).catch((e) => e)
  expect(error).toMatchObject({ code: 'STORAGE_FAILURE', application: 'not_applied' })
  expect(String(error)).not.toContain('sensitive')
})

test('bundled installation asset identity matches the runtime compatibility identity', () => {
  const sql = readFileSync(new URL('../sql/001.sql', import.meta.url), 'utf8')
  const canonical = sql.replaceAll(/fin-supabase-v1:[a-f0-9]{64}/g, 'fin-supabase-v1')
  expect(identity).toBe('fin-supabase-v1:' + createHash('sha256').update(canonical).digest('hex'))
})
