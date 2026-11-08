import { afterEach, expect, test } from 'vitest'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { Miniflare } from 'miniflare'
import { build } from 'esbuild'
import * as z from 'zod'

const disposers: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose()
})
const vaultResult = z.object({
  data: z.object({ vault: z.object({ id: z.string(), revision: z.string() }) }),
})
const accountResult = z.object({ data: z.object({ account: z.object({ id: z.string() }) }) })

test.each(['legacy', 'modern'])(
  'the runnable stdio consumer supports empty catalog → create → financial call (%s)',
  async (era) => {
    const client = new Client(
      { name: 'stdio-consumer', version: '0.0.0' },
      {
        versionNegotiation: { mode: era === 'modern' ? { pin: '2026-07-28' } : 'legacy' },
      },
    )
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['apps/example/mcp-stdio.mjs'],
      env: { FIN_SQLITE_FILENAME: ':memory:' },
    })
    disposers.push(() => client.close())
    await client.connect(transport)
    expect(
      (await client.callTool({ name: 'list_vaults', arguments: {} })).structuredContent,
    ).toEqual({ data: [] })
    const {
      data: { vault },
    } = vaultResult.parse(
      (await client.callTool({ name: 'create_vault', arguments: { name: 'Home' } }))
        .structuredContent,
    )
    const {
      data: { account },
    } = accountResult.parse(
      (
        await client.callTool({
          name: 'create_account',
          arguments: { vaultId: vault.id, name: 'Cash', nature: 'asset', currency: 'KRW' },
        })
      ).structuredContent,
    )
    const receipt = await client.callTool({
      name: 'record_income_expense',
      arguments: {
        vaultId: vault.id,
        accountId: account.id,
        kind: 'income',
        amountMinor: 1200,
        occurredOn: '2026-11-08',
      },
    })
    expect(receipt.structuredContent).toMatchObject({
      data: { changed: true, transaction: { amountMinor: 1200 } },
    })
    expect(
      (await client.callTool({ name: 'query_balances', arguments: { vaultId: vault.id } }))
        .structuredContent,
    ).toMatchObject({ data: { netWorthByCurrency: [{ currency: 'KRW', amountMinor: 1200 }] } })
  },
  15000,
)

test('real Worker HTTP keeps authenticated requests isolated while using D1-backed tools', async () => {
  const bundle = await build({
    entryPoints: ['apps/example/mcp-worker.mjs'],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    conditions: ['workerd'],
    write: false,
    metafile: true,
  })
  const [output] = bundle.outputFiles
  if (!output) throw new Error('Expected Worker bundle')
  expect(
    Object.keys(bundle.metafile.inputs).some((path) =>
      /node_modules\/better-sqlite3\/|(?:^|\/)packages\/sqlite\//.test(path),
    ),
  ).toBe(false)
  const runtime = new Miniflare({
    workers: [
      {
        name: 'api',
        modules: true,
        compatibilityDate: '2026-08-06',
        script: output.text,
        serviceBindings: { D1_REST: 'rest' },
        bindings: {
          FIN_DEMO_GRANTS: JSON.stringify([
            {
              token: 'principal-a',
              accountId: 'test',
              databaseId: 'a',
              apiToken: 'db-a',
              allowCreate: true,
              timeZone: 'Asia/Seoul',
            },
            {
              token: 'principal-b',
              accountId: 'test',
              databaseId: 'b',
              apiToken: 'db-b',
              allowCreate: true,
              timeZone: 'UTC',
            },
            {
              token: 'no-create',
              accountId: 'test',
              databaseId: 'a',
              apiToken: 'db-a',
              allowCreate: false,
            },
          ]),
        },
      },
      {
        name: 'rest',
        modules: true,
        compatibilityDate: '2026-08-06',
        d1Databases: ['A', 'B'],
        // Only the REST envelope is emulated; SQL runs in actual local D1.
        script: `export default { async fetch(request, env) {
        const id = new URL(request.url).pathname.split('/').at(-2);
        const db = id === 'a' ? env.A : id === 'b' ? env.B : undefined;
        if (!db || request.headers.get('authorization') !== 'Bearer db-' + id) return new Response('Forbidden', { status: 403 });
        const body = await request.json();
        try {
          const results = await db.batch(body.batch.map(query => db.prepare(query.sql).bind(...query.params)));
          return Response.json({ success: true, errors: [], result: results.map(result => {
            const columns = Object.keys(result.results[0] ?? {});
            return { success: true, meta: { ...result.meta, served_by_primary: true }, results: { columns, rows: result.results.map(row => columns.map(column => row[column])) } };
          }) });
        } catch(error) { return Response.json({ success: false, errors: [{ code: 7500, message: String(error) }] }, { status: 400 }); }
      } }`,
      },
    ],
  })
  disposers.push(() => runtime.dispose())
  const origin = await runtime.ready
  const url = new URL('/mcp', origin)
  expect((await fetch(url)).status).toBe(401)
  const a = new Client(
    { name: 'http-a', version: '0.0.0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  )
  const b = new Client({ name: 'http-b', version: '0.0.0' })
  const noCreate = new Client({ name: 'http-denied-create', version: '0.0.0' })
  disposers.push(
    () => a.close(),
    () => b.close(),
    () => noCreate.close(),
  )
  await Promise.all([
    a.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { authorization: 'Bearer principal-a' } },
      }),
    ),
    b.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { authorization: 'Bearer principal-b' } },
      }),
    ),
    noCreate.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { authorization: 'Bearer no-create' } },
      }),
    ),
  ])
  expect((await a.callTool({ name: 'list_vaults', arguments: {} })).structuredContent).toEqual({
    data: [],
  })
  const {
    data: { vault },
  } = vaultResult.parse(
    (await a.callTool({ name: 'create_vault', arguments: { name: 'Private A' } }))
      .structuredContent,
  )
  const {
    data: { account },
  } = accountResult.parse(
    (
      await a.callTool({
        name: 'create_account',
        arguments: { vaultId: vault.id, name: 'Cash', nature: 'asset', currency: 'KRW' },
      })
    ).structuredContent,
  )
  const outcomes = await Promise.all([
    a.callTool({
      name: 'record_income_expense',
      arguments: {
        vaultId: vault.id,
        accountId: account.id,
        kind: 'income',
        amountMinor: 900,
        occurredOn: '2026-11-08',
      },
    }),
    b.callTool({ name: 'query_balances', arguments: { vaultId: vault.id } }),
    b.callTool({ name: 'list_vaults', arguments: {} }),
    a.callTool({ name: 'list_vaults', arguments: {} }),
  ])
  expect(outcomes[0]?.structuredContent).toMatchObject({
    data: { changed: true, transaction: { amountMinor: 900 } },
  })
  expect(outcomes[1]?.isError).toBe(true)
  expect(outcomes[1]?.structuredContent).toMatchObject({
    error: { code: 'FORBIDDEN', application: 'not_applied', target: { vaultId: vault.id } },
  })
  expect(outcomes[2]?.structuredContent).toEqual({ data: [] })
  expect(outcomes[3]?.structuredContent).toMatchObject({ data: [{ id: vault.id }] })
  expect(
    (await noCreate.callTool({ name: 'create_vault', arguments: { name: 'Denied' } }))
      .structuredContent,
  ).toMatchObject({ error: { code: 'FORBIDDEN', application: 'not_applied' } })
  const archived = vaultResult.parse(
    (
      await a.callTool({
        name: 'archive_vault',
        arguments: { vaultId: vault.id, expectedRevision: vault.revision },
      })
    ).structuredContent,
  )
  expect(
    (await a.callTool({ name: 'query_balances', arguments: { vaultId: vault.id } }))
      .structuredContent,
  ).toMatchObject({ data: { netWorthByCurrency: [{ amountMinor: 900, currency: 'KRW' }] } })
  expect(
    (
      await a.callTool({
        name: 'reactivate_vault',
        arguments: { vaultId: vault.id, expectedRevision: archived.data.vault.revision },
      })
    ).isError,
  ).toBeFalsy()
}, 30000)
