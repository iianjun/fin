import { randomUUID } from 'node:crypto'
import { Client } from '@neondatabase/serverless'
import { createNeonAdapter } from '@fin/neon'
import { openNeonProxy } from './proxy.js'

/** Run-owned databases, native WS inspection, direct administration and scoped cleanup.
 * Pooled tests administer via the matching direct endpoint, then exercise the pooled URL. */
export async function openNeonFixture() {
  const source = process.env.FIN_NEON_URL
  if (!source)
    throw new Error('FIN_NEON_URL must identify a dedicated test server with CREATEDB permission.')
  const runId = process.env.FIN_NEON_RUN_ID
  if (runId && !/^[a-f0-9]{12}$/.test(runId)) throw new Error('Invalid verification run ID')
  const database = `fin_neon_${runId ? `${runId}_` : ''}${randomUUID().replaceAll('-', '')}`
  const adminUrl = process.env.FIN_NEON_ADMIN_URL ?? source
  const local = ['127.0.0.1', 'localhost'].includes(new URL(source).hostname)
  const adminProxy = local ? await openNeonProxy(adminUrl) : undefined
  const admin = new Client({
    connectionString: adminProxy?.connectionString ?? adminUrl,
    connectionTimeoutMillis: 10000,
    query_timeout: 30000,
  })
  admin.neonConfig.pipelineConnect = false
  admin.on('error', () => {})
  let created = false
  let proxy: Awaited<ReturnType<typeof openNeonProxy>> | undefined
  let db: Client | undefined
  let storage: ReturnType<typeof createNeonAdapter> | undefined
  try {
    await admin.connect()
    await admin.query(`CREATE DATABASE "${database}"`)
    created = true
    const target = new URL(source)
    target.pathname = `/${database}`
    const direct = new URL(adminUrl)
    direct.pathname = `/${database}`
    proxy = local ? await openNeonProxy(target.toString()) : undefined
    const connectionString = proxy?.connectionString ?? target.toString()
    db = new Client({
      connectionString: proxy?.connectionString ?? direct.toString(),
      connectionTimeoutMillis: 10000,
      query_timeout: 30000,
    })
    db.neonConfig.pipelineConnect = false
    db.on('error', () => {})
    await db.connect()
    storage = createNeonAdapter({ connectionString })
    const ownedDb = db,
      ownedStorage = storage,
      ownedProxy = proxy
    return {
      db: ownedDb,
      storage: ownedStorage,
      connectionString,
      // Fault proxies need the real target, never an already routed synthetic hostname.
      targetConnectionString: target.toString(),
      webSocketUrl: ownedProxy?.webSocketUrl,
      async dispose() {
        try {
          await Promise.all([ownedStorage.close(), ownedDb.end()])
        } finally {
          // Close local bridge sockets before dropping. Ordinary DROP waits for backend
          // exit without requiring privileges to signal PostgreSQL maintenance workers.
          await ownedProxy?.dispose()
          try {
            await admin.query(`DROP DATABASE "${database}"${local ? '' : ' WITH (FORCE)'}`)
          } finally {
            await admin.end()
            await adminProxy?.dispose()
          }
        }
      },
    }
  } catch (error) {
    await storage?.close()
    await db?.end().catch(() => {})
    try {
      if (created) await admin.query(`DROP DATABASE "${database}"${local ? '' : ' WITH (FORCE)'}`)
    } finally {
      await admin.end()
      await proxy?.dispose()
      await adminProxy?.dispose()
    }
    throw error
  }
}
