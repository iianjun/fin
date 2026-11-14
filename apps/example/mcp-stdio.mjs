import { createFin, createVault, listVaults } from '@fin-kit/core'
import { createSqliteAdapter } from '@fin-kit/sqlite'
import { createFinTools } from '@fin-kit/tools'
import { registerFinTools } from '@fin-kit/tools/mcp'
import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'

// This local process is authorized for its configured database, including creation.
const storage = createSqliteAdapter({ filename: process.env.FIN_SQLITE_FILENAME ?? ':memory:' })
const access = {
  listVaults: (options) => listVaults({ storage, ...options }),
  createVault: (input) => createVault({ storage, ...input }),
  getFin: async (vaultId) => createFin({ storage, vaultId, timeZone: process.env.TZ }),
}
const host = serveStdio(() => {
  const server = new McpServer({ name: 'fin', version: '0.0.0' })
  registerFinTools(server, createFinTools({ access }))
  return server
})

process.stdin.once('end', async () => {
  await host.close()
  await storage.close()
})
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, async () => {
    await host.close()
    await storage.close()
    process.exit(0)
  })
