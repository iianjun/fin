import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { TursoProtocol } from '../dist/protocol.js'

// This command fails closed, never skips and never provisions resources. The
// explicit marker is an operator assertion of a dedicated *new-engine* DB;
// SQL version strings alone cannot establish engine identity.
const {
  TURSO_TEST_URL: url,
  TURSO_TEST_AUTH_TOKEN: authToken,
  TURSO_TEST_DEDICATED_NEW_ENGINE: dedicated,
  TURSO_TEST_ENGINE_METADATA: engine,
} = process.env
if (!url || !authToken || dedicated !== '1' || !engine) {
  console.error(
    'hosted verification pending: set TURSO_TEST_URL, TURSO_TEST_AUTH_TOKEN, TURSO_TEST_DEDICATED_NEW_ENGINE=1 and TURSO_TEST_ENGINE_METADATA for a dedicated new Turso engine database.',
  )
  process.exit(2)
}
const allowedRouteOrigins = process.env.TURSO_TEST_ROUTE_ORIGINS?.split(',').filter(Boolean) ?? []
const validation = new TursoProtocol({ url, authToken, allowedRouteOrigins })
await validation.close()
const prefix = `fin_probe_${randomUUID().replaceAll('-', '')}_`
const template = await readFile(new URL('./feasibility.sql', import.meta.url), 'utf8')
const schema = template.replaceAll('{{prefix}}', prefix)
const ddl = schema
  .split(';')
  .map((s) => s.trim())
  .filter(Boolean)
const objects = [...schema.matchAll(/CREATE (TABLE|VIEW) (\w+)/g)].map((m) => ({
  kind: m[1],
  name: m[2],
}))
const evidence = {
  date: new Date().toISOString(),
  node: process.version,
  engineOperatorMetadata: engine,
  endpointOrigin: new URL(url).origin,
  allowedRouteOrigins,
  prefix,
  schemaSha256: createHash('sha256').update(template).digest('hex'),
  serverHeaders: {},
  routesObserved: [],
  checks: [],
  cleanup: 'pending',
  scope:
    'Phase A candidate SQL/transport feasibility only; no FinStorage or supported conformance claim',
}
const routes = new Set()
let commitSubmissions = 0
let loseAck = false
let dropped = false
const observedFetch = async (input, init) => {
  const body = JSON.parse(String(init.body))
  const commits = body.requests.some((r) => r.stmt?.sql === 'COMMIT')
  if (commits) commitSubmissions++
  routes.add(new URL(String(input)).origin)
  const response = await globalThis.fetch(input, init)
  for (const name of ['server', 'x-turso-version', 'x-turso-server-version']) {
    const value = response.headers.get(name)
    if (value) evidence.serverHeaders[name] = value
  }
  if (loseAck && commits && !dropped) {
    // Submit an actual real COMMIT, consume the real successful response, then
    // drop it *inside* the transport boundary. Never throw above FinStorage.
    const receipt = await response.clone().json()
    assert.equal(response.status, 200)
    assert.equal(receipt.results?.[0]?.type, 'ok')
    assert.equal(receipt.results?.[0]?.response?.type, 'execute')
    assert.equal(receipt.results?.[1]?.response?.is_autocommit, true)
    dropped = true
    throw new Error('Injected real commit acknowledgement loss')
  }
  return response
}
const settings = { url, authToken, allowedRouteOrigins, timeoutMs: 3000, fetch: observedFetch }
const first = new TursoProtocol(settings)
const second = new TursoProtocol(settings)
let created = false
try {
  await first.immediate(async (tx) => {
    const existing = await tx.execute('SELECT name FROM sqlite_schema WHERE name LIKE ?', [
      `${prefix}%`,
    ])
    assert.deepEqual(existing.rows, [])
    for (const sql of ddl) await tx.execute(sql)
    await tx.execute(`INSERT INTO ${prefix}migrations VALUES (1, ?)`, [
      'turso-phase-a-candidate-v1',
    ])
  })
  created = true
  evidence.checks.push(
    'exact candidate DDL, expression indexes, bounded category view and migration identity',
  )
  await first.immediate(async (tx) => {
    await tx.execute(`INSERT INTO ${prefix}vaults VALUES ('v','Probe','vr',0,'generation',0)`)
    await tx.execute(`INSERT INTO ${prefix}settings VALUES ('v','sr',NULL,NULL)`)
    await tx.execute(
      `INSERT INTO ${prefix}settings VALUES ('v','sr',NULL,NULL) ON CONFLICT(vaultId) DO UPDATE SET revision=excluded.revision`,
    )

    for (const id of ['a', 'b'])
      await tx.execute(`INSERT INTO ${prefix}accounts VALUES ('v',?,?,?,'br','asset','KRW',0,0)`, [
        id,
        id,
        `r-${id}`,
      ])
    await tx.execute(`INSERT INTO ${prefix}categories VALUES ('v','root','cr','Root',NULL,0)`)
    await tx.execute(`INSERT INTO ${prefix}categories VALUES ('v','child','cr','Child','root',0)`)
    await tx.execute(`INSERT INTO ${prefix}categories VALUES ('v','leaf','cr','Leaf','child',0)`)
    await tx.execute(
      `INSERT INTO ${prefix}transactions (vaultId,id,revision,kind,occurredOn,memo,accountId,amountMinor) VALUES ('v','t','tr','income','2026-11-08',?,'a',?)`,
      ['한글\u0000🙂', 9007199254740991],
    )
    await tx.execute(
      `INSERT INTO ${prefix}category_assignments VALUES ('v','t','leaf',9007199254740991,'explicit')`,
    )
    await tx.execute(`INSERT INTO ${prefix}change_records VALUES ('v','h','t',?)`, [
      JSON.stringify({
        before: null,
        after: { amountMinor: 9007199254740991, revision: 'tr', memo: '한글\u0000🙂' },
      }),
    ])
  })
  await second.immediate(async (tx) => {
    assert.equal(
      (await tx.execute(`SELECT path FROM ${prefix}category_paths WHERE id='leaf'`)).rows[0]?.[0],
      'Root / Child / Leaf',
    )
    const values = await tx.execute(
      `SELECT memo,amountMinor FROM ${prefix}transactions WHERE id='t'`,
    )
    assert.deepEqual(values.rows, [['한글\u0000🙂', 9007199254740991n]])
    const history = await tx.execute(`SELECT payload FROM ${prefix}change_records ORDER BY rowid`)
    assert.deepEqual(JSON.parse(history.rows[0][0]), {
      before: null,
      after: { amountMinor: 9007199254740991, revision: 'tr', memo: '한글\u0000🙂' },
    })
    assert.deepEqual((await tx.execute(`SELECT identity FROM ${prefix}migrations`)).rows, [
      ['turso-phase-a-candidate-v1'],
    ])
    assert.deepEqual(
      (
        await tx.execute('SELECT ?, ?, ?, ?, ?', [
          null,
          -9223372036854775808n,
          9223372036854775807n,
          1.25,
          new Uint8Array([0, 255]),
        ])
      ).rows,
      [[null, -9223372036854775808n, 9223372036854775807n, 1.25, new Uint8Array([0, 255])]],
    )
    const metadata = await tx.execute('SELECT sqlite_version()')
    evidence.sqlVersion = metadata.rows
  })
  evidence.checks.push(
    'independent numeric/text/blob/history/identity round trips; rowid history ordering; SQL version (not engine identity)',
  )

  // Exact constraint attempts must fail without changing the earlier account.
  for (const badSQL of [
    `INSERT INTO ${prefix}settings VALUES ('absent','bad',NULL,NULL)`,
    `INSERT INTO ${prefix}accounts VALUES ('v','dup','a','r','br','asset','KRW',0,0)`,
    `INSERT INTO ${prefix}categories VALUES ('v','dup','r','Root',NULL,0)`,
    `INSERT INTO ${prefix}categories VALUES ('v','orphan','r','Orphan','missing',0)`,
    `INSERT INTO ${prefix}change_records VALUES ('v','bad','t','not JSON')`,
    `UPDATE ${prefix}transactions SET amountMinor=9007199254740992 WHERE id='t'`,
    `UPDATE ${prefix}transactions SET amountMinor=1.25 WHERE id='t'`,
  ]) {
    await assert.rejects(
      first.immediate(async (tx) => {
        await tx.execute(`UPDATE ${prefix}accounts SET revision='partial' WHERE id='a'`)
        await tx.execute(badSQL)
      }),
      (error) => error.code === 'STORAGE_FAILURE',
    )
    await second.immediate(async (tx) => {
      assert.deepEqual(
        (await tx.execute(`SELECT revision FROM ${prefix}accounts WHERE id='a'`)).rows,
        [['r-a']],
      )
    })
  }
  evidence.checks.push(
    'per-stream effective constraints: FK, composite FK, unique/name predicates, JSON, safe integer/type checks; late-failure rollback',
  )

  // Hold an IMMEDIATE transaction across each independent-client race. A writer
  // may wait, or fail without committing; it must never commit before release.
  const races = [
    {
      name: 'missing row',
      read: `SELECT id FROM ${prefix}accounts WHERE id='new'`,
      write: `INSERT INTO ${prefix}accounts VALUES ('v','new','New','r','br','asset','KRW',0,0)`,
    },
    {
      name: 'duplicate/name predicate',
      read: `SELECT id FROM ${prefix}accounts WHERE name='Raced'`,
      write: `UPDATE ${prefix}accounts SET name='Raced' WHERE id='b'`,
    },
    {
      name: 'category dependency',
      read: `SELECT id FROM ${prefix}categories WHERE parentId='root'`,
      write: `UPDATE ${prefix}categories SET archived=1 WHERE id='child'`,
    },
    {
      name: 'aggregate dependency',
      read: `SELECT coalesce(sum(amountMinor),0) FROM ${prefix}transactions WHERE accountId='a'`,
      write: `UPDATE ${prefix}transactions SET amountMinor=1 WHERE id='t'`,
    },
  ]
  for (const race of races) {
    // Establish that this exact write is executable without contention; arbitrary
    // SQL/auth failures must not masquerade as successful isolation evidence.
    const rolledBack = new Error('Probe rollback')
    await assert.rejects(
      second.immediate(async (tx) => {
        await tx.execute(race.write)
        throw rolledBack
      }),
      (error) => error === rolledBack,
    )
    let contender
    let committed = false
    let failed = false
    await first.immediate(async (tx) => {
      const before = await tx.execute(race.read)
      contender = second
        .immediate(async (other) => {
          await other.execute(race.write)
        })
        .then(
          () => {
            committed = true
          },
          (error) => {
            assert.equal(error.code, 'STORAGE_FAILURE')
            assert.equal(error.application, 'not_applied')
            failed = true
          },
        )
      await new Promise((resolve) => setTimeout(resolve, 250))
      assert.equal(
        committed,
        false,
        `${race.name} writer committed while IMMEDIATE snapshot was held`,
      )
      assert.deepEqual(
        (await tx.execute(race.read)).rows,
        before.rows,
        `${race.name} snapshot changed`,
      )
    })
    await contender
    evidence.checks.push(
      `${race.name}: ${committed ? 'waited then committed' : failed ? 'rejected without acknowledged commit' : 'unresolved'}`,
    )
    assert.ok(committed || failed)
  }

  // Cascade rollback/commit and SQL predicate shapes used by the candidate.
  await first.immediate(async (tx) => {
    await tx.execute(`DELETE FROM ${prefix}transactions WHERE id='t'`)
  })
  await second.immediate(async (tx) => {
    assert.deepEqual((await tx.execute(`SELECT * FROM ${prefix}category_assignments`)).rows, [])
  })
  evidence.checks.push('composite FK cascade')

  let operationInvocations = 0
  const commitsBefore = commitSubmissions
  loseAck = true
  await assert.rejects(
    first.immediate(async (tx) => {
      operationInvocations++
      await tx.execute(`UPDATE ${prefix}accounts SET revision='ack-lost' WHERE id='a'`)
      await tx.execute(`INSERT INTO ${prefix}change_records VALUES ('v','ack-lost','a',?)`, [
        JSON.stringify({ revision: 'ack-lost' }),
      ])
    }),
    (error) => error.code === 'OUTCOME_UNKNOWN' && error.application === 'unknown',
  )
  loseAck = false
  assert.equal(dropped, true)
  assert.equal(operationInvocations, 1)
  assert.equal(commitSubmissions - commitsBefore, 1)
  await second.immediate(async (tx) => {
    assert.deepEqual(
      (await tx.execute(`SELECT revision FROM ${prefix}accounts WHERE id='a'`)).rows,
      [['ack-lost']],
    )
    assert.deepEqual(
      (await tx.execute(`SELECT payload FROM ${prefix}change_records WHERE id='ack-lost'`)).rows,
      [[JSON.stringify({ revision: 'ack-lost' })]],
    )
  })
  evidence.checks.push(
    'real successful COMMIT acknowledgement loss at fetch boundary; independent state/history; one operation callback/commit; OUTCOME_UNKNOWN (core decision gate remains Phase B)',
  )
  evidence.status = 'Phase A feasibility passed; Phase B/full support pending'
} catch (error) {
  evidence.status = 'failed'
  // Errors may contain SQL/data/token: output only the sanitized public code.
  evidence.failure = error?.code ?? 'PROBE_ASSERTION_FAILED'
  process.exitCode = 1
} finally {
  loseAck = false
  try {
    // Even uncertain schema creation is confined to this generated namespace.
    await second.immediate(async (tx) => {
      if (created) {
        await tx.execute(`DELETE FROM ${prefix}category_assignments`)
        await tx.execute(`DELETE FROM ${prefix}transaction_relations`)
        await tx.execute(`DELETE FROM ${prefix}transactions`)
        await tx.execute(`DELETE FROM ${prefix}settings`)
        await tx.execute(`DELETE FROM ${prefix}categories WHERE id='leaf'`)
        await tx.execute(`DELETE FROM ${prefix}categories WHERE id='child'`)
        await tx.execute(`DELETE FROM ${prefix}categories WHERE id='root'`)
      }
      for (const obj of objects.toReversed())
        await tx.execute(`DROP ${obj.kind} IF EXISTS ${obj.name}`)
    })
    await second.immediate(async (tx) => {
      assert.deepEqual(
        (await tx.execute('SELECT name FROM sqlite_schema WHERE name LIKE ?', [`${prefix}%`])).rows,
        [],
      )
    })
    evidence.cleanup = 'run-owned namespace independently verified absent'
  } catch {
    evidence.cleanup = 'failed: inspect run-owned prefix; no broader cleanup attempted'
    process.exitCode = 1
  }
  await Promise.all([first.close(), second.close()])
  evidence.routesObserved = [...routes]
  evidence.routing =
    routes.size > 1
      ? 'observed configured protocol routing'
      : 'single origin observed; node routing not exercised'
  evidence.streamExpiry = 'pending: no engine-defined idle expiry inferred or measured'
  evidence.fullFinancialConformance = 'pending: Phase B'
  console.log(JSON.stringify(evidence, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2))
}
