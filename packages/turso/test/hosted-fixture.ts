import { randomUUID } from 'node:crypto'
import { createTursoAdapter, type TursoAdapterOptions } from '../src/adapter.js'
import { TursoSessions } from '../src/session.js'
import { openTursoFixture, registerSdkPeer } from './fixture.js'

// The single switch between the hosted engine and the local SQL peer, so shared
// contract suites cannot disagree about which Turso target they exercised.
export const hostedTurso = process.env.FIN_TURSO_HOSTED === '1'
export const tursoContractTarget = hostedTurso
  ? { name: 'Turso hosted new engine', open: () => openHostedTursoFixture() }
  : {
      name: 'Turso adapter over SQLite-backed v3 peer (supplemental)',
      open: () => Promise.resolve(openTursoFixture()),
    }

// Test-only identifier isolation. Production settings/API have no namespace or
// arbitrary SQL surface. Rewrite identifiers in SQL and schema metadata only;
// financial bind values and persisted Change Records are never rewritten.
export async function openHostedTursoFixture() {
  const { TURSO_TEST_URL: url, TURSO_TEST_AUTH_TOKEN: authToken } = process.env
  if (
    !url ||
    !authToken ||
    process.env.TURSO_TEST_DEDICATED_NEW_ENGINE !== '1' ||
    !process.env.TURSO_TEST_ENGINE_METADATA
  )
    throw new Error('hosted verification pending: dedicated new-engine settings required')
  const nativeFetch = globalThis.fetch
  const registrations: ReturnType<typeof registerSdkPeer>[] = []
  const prefix = `fin_test_${randomUUID().replaceAll('-', '')}_`
  const routes = new Set<string>()
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body))
    let metadata = false
    for (const r of body.requests.flatMap(
      (request: { batch?: { steps: unknown[] } }) => request.batch?.steps ?? [],
    ))
      if (r.stmt) {
        metadata ||= r.stmt.sql.includes('FROM sqlite_schema')
        r.stmt.sql = r.stmt.sql.replaceAll('fin_', prefix)
      }
    routes.add(new URL(url).origin)
    const response = await nativeFetch(`${url}/v3/pipeline`, {
      ...init,
      body: JSON.stringify(body),
    })
    if (response.status !== 200) return response
    const envelope = await response.clone().json()
    // This isolation fixture cannot keep identifiers scoped after a node switch.
    // Fail before the SDK adopts another origin instead of touching unowned data.
    if (envelope.base_url !== null)
      throw new Error('Hosted namespace isolation does not support node-switch routing')
    if (!metadata) return response
    for (const r of envelope.results ?? [])
      for (const result of r.response?.result?.step_results ?? [])
        for (const row of result?.rows ?? [])
          for (const v of row) if (v.type === 'text') v.value = v.value.replaceAll(prefix, 'fin_')
    return Response.json(envelope, { status: response.status, headers: response.headers })
  }
  const registration = registerSdkPeer(fetch, authToken)
  registrations.push(registration)
  const settings = { ...registration.settings, timeoutMs: 10000 }
  const probe = new TursoSessions(settings)
  const storages: ReturnType<typeof createTursoAdapter>[] = []
  const storage = createTursoAdapter(settings)
  storages.push(storage)
  try {
    const existing = await probe.transaction((tx) =>
      tx.execute("SELECT name FROM sqlite_schema WHERE substr(name,1,length('fin_'))='fin_'"),
    )
    if (existing.rows.length) throw new Error('Unexpected namespace collision')
  } catch (error) {
    await storage.close()
    await probe.close()
    for (const registered of registrations) registered.dispose()
    throw error
  }
  return {
    storage,
    fetch,
    settings,
    probe,
    client(extra: Partial<TursoAdapterOptions> & { fetch?: typeof globalThis.fetch } = {}) {
      const peer = registerSdkPeer(extra.fetch ?? fetch, authToken)
      registrations.push(peer)
      const other = createTursoAdapter({ ...settings, ...extra, ...peer.settings })
      storages.push(other)
      return other
    },
    async dispose() {
      await Promise.all(storages.map((s) => s.close()))
      try {
        await probe.transaction(async (tx) => {
          const objects = await tx.execute(
            "SELECT name,type FROM sqlite_schema WHERE substr(name,1,length('fin_'))='fin_' AND sql IS NOT NULL",
          )
          const names = new Set(objects.rows.map((r) => r[0]))
          for (const name of [
            'fin_settings',
            'fin_category_assignments',
            'fin_transaction_relations',
            'fin_transactions',
            'fin_change_records',
          ])
            if (names.has(name)) await tx.execute(`DELETE FROM ${name}`)
          if (names.has('fin_categories'))
            for (let i = 0; i < 3; i++)
              await tx.execute(
                'DELETE FROM fin_categories WHERE id NOT IN (SELECT parentId FROM fin_categories WHERE parentId IS NOT NULL)',
              )
          for (const name of ['fin_accounts', 'fin_vaults'])
            if (names.has(name)) await tx.execute(`DELETE FROM ${name}`)
          for (const row of objects.rows.filter((r) => r[1] === 'view')) {
            if (typeof row[0] !== 'string' || !/^fin_\w+$/.test(row[0]))
              throw new Error('Unexpected owned view')
            await tx.execute(`DROP VIEW ${row[0]}`)
          }
          const tables = [
            'fin_settings',
            'fin_category_assignments',
            'fin_transaction_relations',
            'fin_transactions',
            'fin_change_records',
            'fin_categories',
            'fin_accounts',
            'fin_vaults',
            'fin_migrations',
          ]
          for (const name of tables) if (names.has(name)) await tx.execute(`DROP TABLE ${name}`)
        })
        const remaining = await probe.transaction((tx) =>
          tx.execute("SELECT name FROM sqlite_schema WHERE substr(name,1,length('fin_'))='fin_'"),
        )
        if (remaining.rows.length) throw new Error('Owned objects remain')
      } catch {
        // Run-owned prefix is safe diagnostic data; never print credentials/SQL.
        throw new Error(`Hosted cleanup failed; inspect owned namespace ${prefix}`)
      } finally {
        await probe.close()
        for (const registered of registrations) registered.dispose()
        console.log(
          JSON.stringify({
            tursoHostedNamespace: prefix,
            routesObserved: [...routes],
            routing:
              routes.size > 1
                ? 'multiple origins observed'
                : 'single origin observed; node routing unexercised',
            node: process.version,
          }),
        )
      }
    },
  }
}
