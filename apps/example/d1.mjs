import { listVaults } from '@fin/core'
import { createD1Adapter } from '@fin/d1'

const { CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_D1_DATABASE_ID, CLOUDFLARE_API_TOKEN } = process.env
if (
  [CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_D1_DATABASE_ID, CLOUDFLARE_API_TOKEN].some(
    (value) => !value?.trim(),
  )
)
  throw new Error(
    'Set CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_D1_DATABASE_ID and CLOUDFLARE_API_TOKEN for an existing test database.',
  )

const storage = createD1Adapter({
  accountId: CLOUDFLARE_ACCOUNT_ID,
  databaseId: CLOUDFLARE_D1_DATABASE_ID,
  apiToken: CLOUDFLARE_API_TOKEN,
  autoMigrate: false,
})
if (process.argv.includes('--migrate')) await storage.migrate()
console.log(JSON.stringify(await listVaults({ storage }), null, 2))
