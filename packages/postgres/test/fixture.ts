import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { createPostgresAdapter } from '@fin-kit/postgres'

/** A run-owned database, independent inspection connection and complete scoped cleanup. */
export async function openPostgresFixture() {
  if (!process.env.FIN_POSTGRES_URL)
    throw new Error(
      'FIN_POSTGRES_URL must identify a dedicated PostgreSQL test server with CREATEDB permission.',
    )
  const database = `fin_test_${randomUUID().replaceAll('-', '')}`
  const admin = new Client({ connectionString: process.env.FIN_POSTGRES_URL })
  await admin.connect()
  await admin.query(`CREATE DATABASE "${database}"`)
  const url = new URL(process.env.FIN_POSTGRES_URL)
  url.pathname = `/${database}`
  const connectionString = url.toString()
  const db = new Client({ connectionString })
  const storage = createPostgresAdapter({ connectionString })
  try {
    await db.connect()
  } catch (error) {
    await storage.close()
    await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`)
    await admin.end()
    throw error
  }
  return {
    db,
    storage,
    connectionString,
    async dispose() {
      try {
        await storage.close()
        await db.end()
      } finally {
        try {
          await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`)
        } finally {
          await admin.end()
        }
      }
    },
  }
}
