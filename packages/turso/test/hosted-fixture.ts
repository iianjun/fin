import { randomUUID } from 'node:crypto'
import { createTursoAdapter, type TursoAdapterOptions } from '../src/adapter.js'
import { TursoProtocol } from '../src/protocol.js'

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
  const prefix = `fin_test_${randomUUID().replaceAll('-', '')}_`
  const routes = new Set<string>()
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body))
    let metadata = false
    for (const r of body.requests)
      if (r.stmt) {
        metadata ||= r.stmt.sql.includes('FROM sqlite_schema')
        r.stmt.sql = r.stmt.sql.replaceAll('fin_', prefix)
      }
    routes.add(new URL(String(input)).origin)
    const response = await globalThis.fetch(input, { ...init, body: JSON.stringify(body) })
    if (!metadata || response.status !== 200) return response
    const envelope = await response.json()
    for (const r of envelope.results ?? [])
      for (const row of r.response?.result?.rows ?? [])
        for (const v of row) if (v.type === 'text') v.value = v.value.replaceAll(prefix, 'fin_')
    return Response.json(envelope, { status: response.status, headers: response.headers })
  }
  const settings = {
    url,
    authToken,
    allowedRouteOrigins: process.env.TURSO_TEST_ROUTE_ORIGINS?.split(',').filter(Boolean) ?? [],
    timeoutMs: 10000,
    fetch,
  }
  const probe = new TursoProtocol(settings)
  const storages: ReturnType<typeof createTursoAdapter>[] = []
  const storage = createTursoAdapter(settings)
  storages.push(storage)
  try {
    const existing = await probe.immediate((tx) =>
      tx.execute("SELECT name FROM sqlite_schema WHERE substr(name,1,length('fin_'))='fin_'"),
    )
    if (existing.rows.length) throw new Error('Unexpected namespace collision')
  } catch (error) {
    await storage.close()
    await probe.close()
    throw error
  }
  return {
    storage,
    fetch,
    settings,
    probe,
    client(extra: Partial<TursoAdapterOptions> = {}) {
      const other = createTursoAdapter({ ...settings, ...extra })
      storages.push(other)
      return other
    },
    async dispose() {
      await Promise.all(storages.map((s) => s.close()))
      try {
        await probe.immediate(async (tx) => {
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
        const remaining = await probe.immediate((tx) =>
          tx.execute("SELECT name FROM sqlite_schema WHERE substr(name,1,length('fin_'))='fin_'"),
        )
        if (remaining.rows.length) throw new Error('Owned objects remain')
      } catch {
        // Run-owned prefix is safe diagnostic data; never print credentials/SQL.
        throw new Error(`Hosted cleanup failed; inspect owned namespace ${prefix}`)
      } finally {
        await probe.close()
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
