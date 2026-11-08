import { Client } from 'pg'
import { spawnSync } from 'node:child_process'

const mode = process.argv[2]
if (!['local', 'hosted'].includes(mode)) throw new Error('Choose local or hosted.')
if (
  !process.env.SUPABASE_TEST_DATABASE_URL ||
  (mode === 'local'
    ? !process.env.POSTGREST_BIN
    : process.env.SUPABASE_TEST_DEDICATED !== '1' ||
      !process.env.SUPABASE_TEST_URL ||
      !process.env.SUPABASE_TEST_SECRET_KEY)
)
  throw new Error(
    'Provide explicit dedicated test settings; see packages/supabase/README.md. Missing access is pending, never a pass.',
  )
if (!process.version.startsWith('v24.')) throw new Error('This gate targets Node 24.x.')
// No credentials or database URLs are printed. SQL and HTTP stay in run-owned
// namespaces/databases; the fixture installs and removes only its own assets.
const probe = new Client({ connectionString: process.env.SUPABASE_TEST_DATABASE_URL })
await probe.connect()
let serverVersion
try {
  serverVersion = (await probe.query('SHOW server_version')).rows[0]?.server_version
} finally {
  await probe.end()
}
const postgrest =
  mode === 'local'
    ? spawnSync(process.env.POSTGREST_BIN, ['--version'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          ...(process.env.POSTGREST_LIBRARY_PATH
            ? { DYLD_LIBRARY_PATH: process.env.POSTGREST_LIBRARY_PATH }
            : {}),
        },
      })
    : undefined
if (postgrest && (postgrest.error || postgrest.status !== 0))
  throw new Error('Cannot determine local PostgREST version.')
console.log(
  JSON.stringify({
    mode,
    node: process.version,
    pg: '8.23.1',
    supabaseJs: '2.119.0',
    serverVersion,
    postgrest: postgrest?.stdout.trim() ?? 'hosted gateway version not exposed',
    hostedVerification: mode === 'local' ? 'pending' : 'executing',
  }),
)

const pnpm = process.env.npm_execpath
if (!pnpm) throw new Error('Run with pnpm test:supabase:' + mode)
const command = /\.[cm]?js$/.test(pnpm) ? process.execPath : pnpm
const args = [
  ...(command === process.execPath ? [pnpm] : []),
  'exec',
  'vitest',
  'run',
  ...(mode === 'hosted' ? ['--testTimeout=120000', '--hookTimeout=120000'] : []),
  'packages/supabase/src/adapter.test.ts',
  'packages/supabase/test/conformance.test.ts',
  'packages/core/src/fin.test.ts',
  'packages/tools/src/tools.test.ts',
  'packages/tools/src/consumer.test.ts',
]
const result = spawnSync(command, args, {
  stdio: 'inherit',
  env: {
    ...process.env,
    FIN_SUPABASE_LOCAL: mode === 'local' ? '1' : '0',
    FIN_SUPABASE_HOSTED: mode === 'hosted' ? '1' : '0',
  },
})
if (result.error) throw result.error
process.exitCode = result.status ?? 1
