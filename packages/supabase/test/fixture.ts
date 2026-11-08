import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createHmac, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { Client } from 'pg'
import { createSupabaseAdapter } from '../src/adapter.js'
import type { SupabaseAdapterOptions } from '../src/adapter.js'

// Owns real SQL preparation, HTTP routing and cleanup. Local uses a run-owned
// database and legacy JWT; hosted uses run-owned SQL assets and a modern key.
// Neither a local token nor these test-only rewrites prove hosted gateway support.
export async function openSupabaseFixture(options: { install?: boolean; scoped?: boolean } = {}) {
  const hosted = process.env.FIN_SUPABASE_HOSTED === '1'
  if (
    !process.env.SUPABASE_TEST_DATABASE_URL ||
    (hosted
      ? process.env.SUPABASE_TEST_DEDICATED !== '1' ||
        !process.env.SUPABASE_TEST_URL ||
        !process.env.SUPABASE_TEST_SECRET_KEY
      : process.env.FIN_SUPABASE_LOCAL !== '1' || !process.env.POSTGREST_BIN)
  )
    throw new Error(
      'Explicit gate requires a dedicated PostgreSQL test URL and local PostgREST or hosted project/secret-key settings.',
    )
  const clusterUrl = new URL(process.env.SUPABASE_TEST_DATABASE_URL)
  const run = randomUUID().replaceAll('-', '')
  const database = `fin_test_${run}`
  const scoped = hosted || options.scoped === true
  const namespace = scoped ? `fin_supabase_${run}` : 'fin_supabase'
  const prefix = `${namespace}_`
  // Only known SQL identifiers/catalog literals are rewritten. Bound financial
  // values and HTTP bodies are never changed by test isolation.
  const scopedSql = (sql: string) =>
    scoped
      ? sql
          .replaceAll(
            "left(p.proname,13)='fin_supabase_'",
            `left(p.proname,${prefix.length})='${prefix}'`,
          )
          .replace(/\bfin_supabase_(check_schema|context|commit)\b/g, `${prefix}$1`)
          .replace(/\bfin_supabase\b/g, namespace)
          .replaceAll('public.host_data', `public.${namespace}_host_data`)
      : sql
  const manager = new Client({ connectionString: clusterUrl.href })
  await manager.connect()
  let connection = new URL(clusterUrl)
  let admin: Client | undefined
  let child: ReturnType<typeof spawn> | undefined
  let dropped = false
  try {
    if (!hosted) {
      await manager.query(`BEGIN; SELECT pg_advisory_xact_lock(686100430002); DO $$ BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
      END $$; COMMIT;`)
      await manager.query(`CREATE DATABASE ${database}`)
      connection.pathname = `/${database}`
    }
    admin = new Client({ connectionString: connection.href })
    await admin.connect()
    const sql = scopedSql(await readFile(new URL('../sql/001.sql', import.meta.url), 'utf8'))
    if (options.install !== false) await admin.query(sql)
    const secret = 'fin-supabase-local-test-only-32-byte-secret'
    const expires = Math.floor(Date.now() / 1000) + 3600
    const token = (role: string) => {
      const payload = Buffer.from(JSON.stringify({ role, exp: expires })).toString('base64url')
      const message = `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${payload}`
      return `${message}.${createHmac('sha256', secret).update(message).digest('base64url')}`
    }
    let base = process.env.SUPABASE_TEST_URL ?? ''
    if (!hosted) {
      const socket = createServer()
      socket.listen(0, '127.0.0.1')
      await once(socket, 'listening')
      const address = socket.address()
      if (!address || typeof address === 'string') throw new Error('Missing test port')
      const port = address.port
      await new Promise<void>((resolve, reject) =>
        socket.close((error) => (error ? reject(error) : resolve())),
      )
      base = `http://127.0.0.1:${port}`
      child = spawn(process.env.POSTGREST_BIN ?? '', [], {
        env: {
          ...process.env,
          ...(process.env.POSTGREST_LIBRARY_PATH
            ? { DYLD_LIBRARY_PATH: process.env.POSTGREST_LIBRARY_PATH }
            : {}),
          PGRST_DB_URI: connection.href,
          PGRST_DB_SCHEMAS: 'public',
          PGRST_DB_ANON_ROLE: 'anon',
          PGRST_JWT_SECRET: secret,
          PGRST_SERVER_HOST: '127.0.0.1',
          PGRST_SERVER_PORT: String(port),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let log = ''
      child.stderr?.on('data', (chunk) => {
        log += String(chunk)
      })
      child.stdout?.on('data', () => {})
      let ready = false
      for (let attempt = 0; attempt < 100; attempt++) {
        if (child.exitCode !== null || child.signalCode !== null)
          throw new Error(`PostgREST exited: ${log}`)
        try {
          ready =
            (
              await fetch(base, {
                headers: { Authorization: `Bearer ${token('service_role')}` },
                signal: AbortSignal.timeout(1000),
              })
            ).status === 200
        } catch {}
        if (ready) break
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      if (!ready) throw new Error('Local PostgREST readiness failed')
    }
    const apiKey = hosted ? (process.env.SUPABASE_TEST_SECRET_KEY ?? '') : 'sb_secret_local_test'
    const transport: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      const headers = new Headers(init?.headers)
      if (!hosted) headers.set('Authorization', `Bearer ${token('service_role')}`)
      const path = scoped
        ? url.pathname.replace(/fin_supabase_(check_schema|context|commit)$/, `${prefix}$1`)
        : url.pathname.replace('/rest/v1', '')
      return fetch(`${base}${hosted ? path : path.replace('/rest/v1', '')}`, { ...init, headers })
    }
    const storage = createSupabaseAdapter({ url: base, apiKey, fetch: transport })
    if (hosted && options.install !== false) {
      let ready = false
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          await storage.checkSchema()
          ready = true
          break
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      if (!ready) throw new Error('Hosted schema-cache readiness failed')
    }
    const sqlClient = admin
    return {
      // Independent SQL inspection stays within the fixture's namespace.
      admin: {
        query: (sql: string, values?: unknown[]) => sqlClient.query(scopedSql(sql), values),
      },
      sql,
      base,
      hosted,
      token,
      rpcBase: hosted ? `${base}/rest/v1` : base,
      fetch: transport,
      storage,
      // For independent packed consumers, rewrite routing without touching data.
      namespace,
      databaseName: database,
      client(overrides: Partial<SupabaseAdapterOptions> = {}) {
        return createSupabaseAdapter({ url: base, apiKey, fetch: transport, ...overrides })
      },
      async dispose() {
        if (dropped) return
        dropped = true
        if (child && child.exitCode === null && child.signalCode === null) {
          child.kill()
          await once(child, 'exit')
        }
        if (hosted) {
          await sqlClient.query('ROLLBACK')
          await sqlClient.query(
            `DROP FUNCTION IF EXISTS public.${prefix}commit(jsonb,jsonb,jsonb,jsonb,text); DROP FUNCTION IF EXISTS public.${prefix}context(jsonb,text); DROP FUNCTION IF EXISTS public.${prefix}check_schema(); DROP SCHEMA IF EXISTS ${namespace} CASCADE; DROP TABLE IF EXISTS public.${namespace}_host_data; NOTIFY pgrst, 'reload schema';`,
          )
        }
        await sqlClient.end()
        if (!hosted) await manager.query(`DROP DATABASE ${database} WITH (FORCE)`)
        await manager.end()
      },
    }
  } catch (error) {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill()
      await once(child, 'exit')
    }
    if (hosted && admin) {
      await admin.query('ROLLBACK')
      await admin.query(
        `DROP FUNCTION IF EXISTS public.${prefix}commit(jsonb,jsonb,jsonb,jsonb,text); DROP FUNCTION IF EXISTS public.${prefix}context(jsonb,text); DROP FUNCTION IF EXISTS public.${prefix}check_schema(); DROP SCHEMA IF EXISTS ${namespace} CASCADE; DROP TABLE IF EXISTS public.${namespace}_host_data;`,
      )
    }
    await admin?.end()
    if (!hosted) await manager.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`)
    await manager.end()
    throw error
  }
}
