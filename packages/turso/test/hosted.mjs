import { spawnSync, execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const required = ['TURSO_TEST_URL', 'TURSO_TEST_AUTH_TOKEN', 'TURSO_TEST_ENGINE_METADATA']
if (
  process.env.TURSO_TEST_DEDICATED_NEW_ENGINE !== '1' ||
  required.some((name) => !process.env[name])
) {
  console.error(
    'hosted verification pending: set TURSO_TEST_URL, TURSO_TEST_AUTH_TOKEN, TURSO_TEST_DEDICATED_NEW_ENGINE=1 and TURSO_TEST_ENGINE_METADATA for a dedicated new Turso engine database.',
  )
  process.exit(2)
}
const sourceSha256 = Object.fromEntries(
  ['adapter.ts', 'session.ts', 'schema.ts', 'storage.ts'].map((name) => [
    name,
    createHash('sha256')
      .update(readFileSync(new URL('../src/' + name, import.meta.url)))
      .digest('hex'),
  ]),
)
const implementation = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).length > 0
console.log(
  JSON.stringify({
    date: new Date().toISOString(),
    node: process.version,
    implementation,
    dirty,
    sourceSha256,
    dependencies: JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
      .dependencies,
    engineOperatorMetadata: process.env.TURSO_TEST_ENGINE_METADATA,
    scope:
      'Official SDK hosted adapter/financial/tools checks; previous custom-protocol evidence does not apply',
  }),
)
const pnpm = process.env.npm_execpath ?? 'pnpm'
const node = /\.[cm]?js$/.test(pnpm)
const run = spawnSync(
  node ? process.execPath : pnpm,
  [
    ...(node ? [pnpm] : []),
    'exec',
    'vitest',
    'run',
    'packages/core/src/fin.test.ts',
    'packages/tools/src/tools.test.ts',
    'packages/turso/test/conformance.test.ts',
    '-t',
    'Turso hosted new engine',
    '--testTimeout=60000',
    '--hookTimeout=60000',
  ],
  { stdio: 'inherit', env: { ...process.env, FIN_TURSO_HOSTED: '1' } },
)
process.exitCode = run.status ?? 1

console.log(
  JSON.stringify({
    hostedExecutableChecks: run.status === 0 ? 'passed' : 'failed',
    sdk: '@tursodatabase/serverless@1.4.1',
    upstreamLimitations:
      'SDK redirect policy and malformed-response handling remain upstream responsibilities',
    streamExpiry: 'pending: service expiry has not been characterized by this command',
    supportedCompletion: false,
  }),
)
