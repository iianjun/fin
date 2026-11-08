import { createFin, createVault, listVaults, FinError } from '@fin/core'
import { createD1Adapter } from '@fin/d1'
import { createFinTools } from '@fin/tools'
import { registerFinTools } from '@fin/tools/mcp'
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server'
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/server/validators/cf-worker'

// Demo host: an application-authenticated principal gets a separate configured
// database. Replace this host policy with your own verified identity and grants.
// Never take the principal or allowed Vault IDs from model tool arguments.
export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname !== '/mcp') return new Response('Not found', { status: 404 })
    const grants = JSON.parse(env.FIN_DEMO_GRANTS)
    const credential = request.headers.get('authorization')
    const grant = grants.find((item) => credential === `Bearer ${item.token}`)
    if (!grant) return new Response('Unauthorized', { status: 401 })
    const storage = createD1Adapter({
      accountId: grant.accountId,
      databaseId: grant.databaseId,
      apiToken: grant.apiToken,
      // A service binding is optional; production defaults to Cloudflare's REST URL.
      ...(env.D1_REST ? { fetch: env.D1_REST.fetch.bind(env.D1_REST) } : {}),
    })
    const access = {
      listVaults: (options) => listVaults({ storage, ...options }),
      async createVault(input) {
        if (!grant.allowCreate)
          throw new FinError(
            'FORBIDDEN',
            'Vault creation denied.',
            'Ask the host for creation permission.',
          )
        return createVault({ storage, ...input })
      },
      async getFin(vaultId) {
        const vaults = await listVaults({ storage, includeArchived: true })
        if (!vaults.some((vault) => vault.id === vaultId))
          throw new FinError(
            'FORBIDDEN',
            'Vault access denied.',
            'Choose a Vault from the authorized catalog.',
            'not_applied',
            { vaultId },
          )
        return createFin({ storage, vaultId, timeZone: grant.timeZone })
      },
    }
    const handler = createMcpHandler(() => {
      const server = new McpServer(
        { name: 'fin', version: '0.0.0' },
        { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() },
      )
      registerFinTools(server, createFinTools({ access }))
      return server
    })
    try {
      return await handler.fetch(request)
    } finally {
      await handler.close()
    }
  },
}
