import { Miniflare } from 'miniflare'
import { vi } from 'vitest'
import { createD1Adapter } from '@fin/d1'

// This fixture emulates only the public REST envelope. SQL executes in actual
// local D1. It is not evidence of the remote REST service's behavior.
export async function openD1Fixture() {
  const runtime = new Miniflare({
    modules: true,
    compatibilityDate: '2026-08-06',
    d1Databases: ['DB'],
    script: `export default {
      async fetch(request, env) {
        const body = await request.json();
        try {
          const results = await env.DB.batch(body.batch.map(query =>
            env.DB.prepare(query.sql).bind(...query.params)
          ));
          return Response.json({ success: true, errors: [], result: results.map(result => {
            const columns = Object.keys(result.results[0] ?? {});
            return { success: true, meta: { ...result.meta, served_by_primary: true },
              results: { columns, rows: result.results.map(row => columns.map(column => row[column])) }
            };
          }) });
        } catch (error) {
          return Response.json({ success: false, errors: [{ code: 7500, message: String(error) }] }, { status: 400 });
        }
      }
    }`,
  })
  try {
    const database = await runtime.getD1Database('DB')
    const transport = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init)
      const response = await runtime.dispatchFetch(request.url, {
        method: request.method,
        headers: Object.fromEntries(request.headers),
        body: await request.text(),
      })
      return new Response(await response.text(), { status: response.status })
    })
    const options = {
      accountId: 'test-account',
      databaseId: 'test-database',
      apiToken: 'test-token',
      fetch: transport,
    }
    const storage = createD1Adapter(options)
    return { storage, options, transport, database, dispose: runtime.dispose.bind(runtime) }
  } catch (error) {
    await runtime.dispose()
    throw error
  }
}
