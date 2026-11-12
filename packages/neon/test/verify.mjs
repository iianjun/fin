import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { Client } from '@neondatabase/serverless'

const mode = process.argv[2]
if (!['local', 'hosted'].includes(mode)) throw new Error('Choose local or hosted verification.')
if (!process.version.startsWith('v24.')) throw new Error('Neon verification requires Node 24.x.')
const pnpm = process.env.npm_execpath
if (!pnpm) throw new Error('Run this command through pnpm.')
let direct = process.env.FIN_NEON_DIRECT_URL,
  pooled = process.env.FIN_NEON_POOLED_URL
if (mode === 'hosted' && process.env.FIN_NEON_CREDENTIALS_FILE) {
  const credentials = JSON.parse(readFileSync(process.env.FIN_NEON_CREDENTIALS_FILE, 'utf8'))
  direct ??= credentials.direct
  pooled ??= credentials.pooled
}
if (mode === 'hosted' && (!direct || !pooled))
  throw new Error(
    'Hosted verification requires FIN_NEON_DIRECT_URL and FIN_NEON_POOLED_URL, or FIN_NEON_CREDENTIALS_FILE with direct/pooled keys. No hosted checks ran.',
  )
if (mode === 'local' && !process.env.FIN_NEON_URL)
  throw new Error(
    'Local verification requires FIN_NEON_URL for a dedicated PostgreSQL server with CREATEDB permission. No integration checks ran.',
  )
const targets =
  mode === 'hosted'
    ? [
        ['direct', direct],
        ['pooled', pooled],
      ]
    : [['local WS', process.env.FIN_NEON_URL]]
if (mode === 'hosted') {
  const a = new URL(direct),
    b = new URL(pooled)
  if (
    !a.hostname.endsWith('.neon.tech') ||
    !b.hostname.includes('-pooler.') ||
    b.hostname.replace('-pooler.', '.') !== a.hostname ||
    a.pathname !== b.pathname
  )
    throw new Error(
      'Hosted verification requires matching Neon direct and pooled endpoints for the same dedicated database/project.',
    )
}
console.log(
  `Neon verification: ${mode}; ${process.version}; @neondatabase/serverless 1.2.0; native Node WebSocket`,
)
let failed = false
for (const [kind, url] of targets) {
  const runId = randomUUID().replaceAll('-', '').slice(0, 12)
  const prefix = `fin_neon_${runId}_`
  let admin
  if (mode === 'hosted') {
    admin = new Client({
      connectionString: direct,
      connectionTimeoutMillis: 10000,
      query_timeout: 30000,
    })
    admin.neonConfig.pipelineConnect = false
    admin.on('error', () => {})
  }
  try {
    if (admin) {
      await admin.connect()
      const { rows } = await admin.query(
        'SELECT version() AS version, rolcreatedb AS createdb FROM pg_roles WHERE rolname=current_user',
      )
      if (!rows[0]?.createdb) throw new Error('The dedicated test role needs CREATEDB permission.')
      console.log(`${kind}: ${rows[0].version}; isolated database prefix ${prefix}`)
    }
    const code = await new Promise((resolve, reject) => {
      const nodePnpm = /\.[cm]?js$/.test(pnpm)
      const child = spawn(
        nodePnpm ? process.execPath : pnpm,
        [
          ...(nodePnpm ? [pnpm] : []),
          'exec',
          'vitest',
          'run',
          'packages/neon',
          'packages/core/src/fin.test.ts',
          'packages/tools/src/consumer.test.ts',
          '--no-file-parallelism',
          '--testTimeout=240000',
          '--hookTimeout=60000',
          '--reporter=verbose',
        ],
        {
          stdio: 'inherit',
          env: {
            ...process.env,
            FIN_NEON_URL: url,
            FIN_NEON_ADMIN_URL: mode === 'hosted' ? direct : url,
            FIN_NEON_KIND: kind,
            FIN_NEON_RUN_ID: runId,
            FIN_NEON_HOSTED: mode === 'hosted' ? '1' : '',
            FIN_POSTGRES_URL: '',
            FIN_SUPABASE_LOCAL: '',
            FIN_SUPABASE_HOSTED: '',
          },
        },
      )
      child.on('error', reject)
      child.on('exit', (code) => resolve(code ?? 1))
    })
    if (code !== 0) failed = true
    console.log(`${kind}: ${code === 0 ? 'PASS' : 'FAIL'}`)
  } catch {
    // Driver errors may embed connection details. Deliberately omit them from evidence output.
    console.error(
      `${kind}: FAIL (connection, permission or verification setup; credentials omitted)`,
    )
    failed = true
  } finally {
    if (admin) {
      try {
        // Only this invocation's randomly owned prefix; never existing application databases.
        const { rows } = await admin.query(
          'SELECT datname FROM pg_database WHERE left(datname,$1)=$2',
          [prefix.length, prefix],
        )
        for (const { datname } of rows) {
          if (/^fin_neon_[a-f0-9]{12}_[a-f0-9]{32}$/.test(datname)) {
            await admin.query(`DROP DATABASE "${datname}" WITH (FORCE)`)
          } else {
            console.error('Unexpected run-owned database name; cleanup incomplete')
            failed = true
          }
        }
        console.log(`${kind}: run-owned database cleanup complete (${rows.length} leftovers)`)
      } catch {
        console.error(`${kind}: cleanup failed; inspect only prefix ${prefix}`)
        failed = true
      }
      await admin.end().catch(() => {
        failed = true
      })
    }
  }
}
if (failed) process.exitCode = 1
