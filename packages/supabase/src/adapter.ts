import { createClient } from '@supabase/supabase-js'
import { AsyncLocalStorage } from 'node:async_hooks'
import { z } from 'zod'
import { FinError } from '@fin/provider'
import type {
  DomainContext,
  FinStorage,
  MutationDecision,
  MutationRequest,
  ReadRequest,
} from '@fin/provider'
import {
  changeRecord,
  changesSchema,
  guardSchema,
  identity,
  readContext,
  receiptSchema,
} from './context.js'

export interface SupabaseAdapterOptions {
  url: string
  apiKey: string
  timeoutMs?: number
  /** A host-supplied transport must not retry or follow redirects. */
  fetch?: typeof fetch
}

// Factories validate without network I/O; no externally supplied SDK clients or SQL bootstrap surface.
export function createSupabaseAdapter(
  options: SupabaseAdapterOptions,
): FinStorage & { checkSchema(): Promise<void> } {
  // Each rejection names the setting but never echoes the supplied value.
  const rawUrl: unknown = options?.url
  const url = typeof rawUrl === 'string' && URL.canParse(rawUrl) ? new URL(rawUrl) : undefined
  if (
    !url ||
    !['https:', 'http:'].includes(url.protocol) ||
    (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new FinError(
      'INVALID_INPUT',
      'Invalid Supabase adapter url.',
      'Supply the project origin over https (http only on loopback) without credentials, path, query or hash.',
    )
  if (typeof options.apiKey !== 'string' || !/^sb_secret_[A-Za-z0-9_-]+$/.test(options.apiKey))
    throw new FinError(
      'INVALID_INPUT',
      'Invalid Supabase adapter apiKey.',
      'Supply a server-held sb_secret_ key.',
    )
  if (options.fetch !== undefined && typeof options.fetch !== 'function')
    throw new FinError(
      'INVALID_INPUT',
      'Invalid Supabase adapter fetch.',
      'Supply a fetch function that never retries or follows redirects, or omit it.',
    )
  if (
    options.timeoutMs !== undefined &&
    (!Number.isSafeInteger(options.timeoutMs) ||
      options.timeoutMs < 1 ||
      options.timeoutMs > 120000)
  )
    throw new FinError(
      'INVALID_INPUT',
      'Invalid Supabase adapter timeoutMs.',
      'Supply a positive integer timeoutMs up to 120000, or omit it.',
    )
  const transport = options.fetch ?? globalThis.fetch
  const apiKey = options.apiKey
  const timeoutMs = options.timeoutMs ?? 30000
  const decisionScope = new AsyncLocalStorage<{ nested: boolean }>()
  const client = createClient(url.href, apiKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    db: { retry: false },
    global: {
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers)
        // The SDK's Data API wrapper currently falls back to key-as-Bearer.
        // This profile has no user JWT: modern secret keys belong in apikey only.
        if (headers.get('Authorization') === `Bearer ${apiKey}`) headers.delete('Authorization')
        const response = await transport(input, { ...init, headers, redirect: 'manual' })
        if (response.redirected || (response.status >= 300 && response.status < 400))
          throw new Error('Redirect rejected')
        if (!/^application\/json(?:;|$)/i.test(response.headers.get('Content-Type') ?? ''))
          throw new Error('Invalid response media type')
        return response
      },
    },
  })
  const errorEnvelope = z.strictObject({
    code: z.string(),
    message: z.string(),
    details: z.string().nullable(),
    hint: z.string().nullable(),
  })

  // A PostgreSQL error receipt positively establishes statement/transaction abort.
  // Gateway status alone (including timeout/5xx) never establishes non-application.
  // A commit turns every ambiguous response into OUTCOME_UNKNOWN; a createVault
  // commit also reads a duplicate Vault id as a lost creation race.
  async function rpc(
    name: string,
    body: object,
    commit?: { createVault: boolean },
  ): Promise<unknown> {
    // PostgreSQL jsonb rejects NUL and unpaired UTF-16 surrogates. Escape only
    // those code units plus the escape marker; valid Unicode and JSON numbers
    // stay unchanged. This injective codec also preserves literal backslashes.
    const serialized = JSON.stringify(body, (_, value) =>
      typeof value === 'string'
        ? // oxlint-disable-next-line no-control-regex -- NUL must be encoded before PostgreSQL jsonb parsing.
          value.replace(/[\\\u0000\uD800-\uDFFF]/gu, (char) =>
            char === '\\'
              ? '\\\\'
              : char === '\u0000'
                ? '\\0'
                : `\\u${char.charCodeAt(0).toString(16)}`,
          )
        : value,
    )
    const outcomeUnknown = new FinError(
      'OUTCOME_UNKNOWN',
      'The Supabase commit outcome is unknown.',
      'Inspect financial state and Change Records before submitting another write.',
      'unknown',
    )
    let response: { status: number; data: unknown; error: unknown }
    try {
      const args: Record<string, unknown> = JSON.parse(serialized)
      response = await client.rpc(name, args).abortSignal(AbortSignal.timeout(timeoutMs))
    } catch {
      if (commit) throw outcomeUnknown
      throw new FinError(
        'STORAGE_FAILURE',
        'The Supabase SDK request failed.',
        'Check connection, SQL installation and service permissions.',
      )
    }
    if (response.error || response.status !== 200) {
      const parsed = errorEnvelope.safeParse(response.error)
      if (parsed.success) {
        const code = parsed.data.code
        const expected: Record<string, number> = {
          PT409: 409,
          PT404: 404,
          PT412: 412,
          PT400: 400,
          '23505': 409,
          '23503': 409,
          '23514': 400,
          '23502': 400,
          '22003': 400,
          '40001': 500,
          '40P01': 500,
          '42501': 403,
          PGRST202: 404,
          PGRST205: 404,
        }
        if (expected[code] === response.status) {
          if (
            code === 'PT409' ||
            code === '40001' ||
            code === '40P01' ||
            (code === '23505' && commit?.createVault)
          )
            throw new FinError(
              'CONFLICT',
              'The Vault changed before this plan could commit.',
              'Read fresh state and decide whether to submit a new operation.',
            )
          if (['PT412', 'PGRST202', 'PGRST205'].includes(code))
            throw new FinError(
              'SCHEMA_INCOMPATIBLE',
              'Supabase fin SQL is missing, incompatible or unavailable in the schema cache.',
              'Have an administrator install the matching SQL and verify schema-cache readiness.',
            )
          if (code === 'PT404')
            throw new FinError(
              'NOT_FOUND',
              'Vault does not exist.',
              'List Vaults or create a new Vault.',
            )
          throw new FinError(
            'STORAGE_FAILURE',
            'Supabase rejected the storage operation.',
            'Inspect schema, permissions and stored data before submitting another operation.',
          )
        }
      }
      throw commit
        ? outcomeUnknown
        : new FinError(
            'STORAGE_FAILURE',
            'Supabase returned an invalid error receipt.',
            'Inspect connection, schema and permissions.',
          )
    }
    try {
      return JSON.parse(JSON.stringify(response.data), (_, value) => {
        if (typeof value !== 'string') return value
        const pattern = /\\(\\|0|u[dD][89a-fA-F][0-9a-fA-F]{2})/g
        if (value.replace(pattern, '').includes('\\')) throw new Error('Invalid text encoding')
        return value.replace(pattern, (_, escaped: string) =>
          escaped === '\\'
            ? '\\'
            : escaped === '0'
              ? '\u0000'
              : String.fromCharCode(Number.parseInt(escaped.slice(1), 16)),
        )
      })
    } catch {
      if (commit) throw outcomeUnknown
      throw new FinError(
        'STORAGE_FAILURE',
        'Invalid Supabase context encoding.',
        'Inspect the schema and stored data.',
      )
    }
  }

  // Preserve the async decision scope, including continuations of invalid async
  // callbacks. Swallowed nested rejections still invalidate the outer decision.
  function execute<T>(operation: () => Promise<T>): Promise<T> {
    const scope = decisionScope.getStore()
    if (scope) {
      scope.nested = true
      const rejection = Promise.reject<T>(
        new FinError(
          'INVALID_INPUT',
          'Storage operations cannot be nested in a mutation decision.',
          'Keep decisions synchronous and free of storage operations.',
        ),
      )
      void rejection.catch(() => {})
      return rejection
    }
    return operation()
  }

  return {
    checkSchema(): Promise<void> {
      return execute(async () => {
        const value = await rpc('fin_supabase_check_schema', {})
        if (!z.strictObject({ identity: z.literal(identity) }).safeParse(value).success)
          throw new FinError(
            'SCHEMA_INCOMPATIBLE',
            'The Supabase fin schema receipt is incompatible.',
            'Install the matching administrative SQL.',
          )
      })
    },
    read(request: ReadRequest): Promise<DomainContext> {
      return execute(async () => {
        const nonce = crypto.randomUUID()
        const value = await rpc('fin_supabase_context', { p_request: request, p_nonce: nonce })
        try {
          return readContext(value, request, nonce).context
        } catch (error) {
          if (error instanceof FinError) throw error
          throw new FinError(
            'STORAGE_FAILURE',
            'Invalid Supabase financial context.',
            'Inspect the schema and stored data; no mutation was submitted.',
          )
        }
      })
    },
    mutate<T>(
      request: MutationRequest,
      decide: (context: Readonly<DomainContext>) => MutationDecision<T>,
    ): Promise<T> {
      return execute(async () => {
        const nonce = crypto.randomUUID()
        const value = await rpc('fin_supabase_context', { p_request: request, p_nonce: nonce })
        let loaded: ReturnType<typeof readContext>
        try {
          loaded = readContext(value, request, nonce)
        } catch (error) {
          if (error instanceof FinError) throw error
          throw new FinError(
            'STORAGE_FAILURE',
            'Invalid Supabase mutation context.',
            'Inspect the schema and stored data; no mutation was submitted.',
          )
        }
        // Save the primitive guard before user code can touch the context.
        const guard = loaded.guard ?? { generation: crypto.randomUUID(), stamp: '0' }
        const scope = { nested: false }
        const decision = decisionScope.run(scope, () => decide(loaded.context))
        if (decision && typeof decision === 'object' && 'then' in decision) {
          void Promise.resolve(decision).catch(() => {})
          throw new FinError(
            'INVALID_INPUT',
            'Mutation decisions must be synchronous.',
            'Return a synchronous decision without I/O.',
          )
        }
        if (scope.nested || !decision || !['changed', 'unchanged'].includes(decision.kind))
          throw new FinError(
            'INVALID_INPUT',
            'Invalid or nested mutation decision.',
            'Return a synchronous changed or unchanged decision without storage calls.',
          )
        if (decision.kind === 'unchanged') return decision.result
        let changes: z.output<typeof changesSchema>
        let record: z.output<typeof changeRecord>
        try {
          changes = changesSchema.parse(decision.changes)
          record = changeRecord.parse(decision.record)
          guardSchema.parse(guard)
          if (
            ('vaultId' in request && request.vaultId !== record.vaultId) ||
            (changes.vault && changes.vault.id !== record.vaultId) ||
            (request.kind === 'createVault' && (!changes.vault || !changes.settings))
          )
            throw new Error('Invalid plan scope')
        } catch (error) {
          if (error instanceof FinError) throw error
          throw new FinError(
            'INVALID_INPUT',
            'Invalid Supabase mutation plan.',
            'Supply valid scoped state and the exact Change Record.',
          )
        }
        const commitNonce = crypto.randomUUID()
        const receipt = await rpc(
          'fin_supabase_commit',
          {
            p_request: request,
            p_guard: guard,
            p_changes: changes,
            p_record: record,
            p_nonce: commitNonce,
          },
          { createVault: request.kind === 'createVault' },
        )
        const parsed = receiptSchema.safeParse(receipt)
        if (
          !parsed.success ||
          parsed.data.nonce !== commitNonce ||
          parsed.data.vaultId !== record.vaultId ||
          parsed.data.recordId !== record.id ||
          parsed.data.generation !== guard.generation ||
          parsed.data.stamp !== (BigInt(guard.stamp) + 1n).toString()
        )
          throw new FinError(
            'OUTCOME_UNKNOWN',
            'Supabase did not return a complete matching commit receipt.',
            'Inspect financial state and Change Records before submitting another write.',
            'unknown',
          )
        return decision.result
      })
    },
  }
}
