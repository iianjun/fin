import { identity as supabaseIdentity } from '../../supabase/src/context.js'
import { openSupabaseFixture } from '../../supabase/test/fixture.js'
import { execFile, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { build } from 'esbuild'
import { expect, test } from 'vitest'
import { openNeonFixture } from '../../neon/test/fixture.js'
import { openPostgresFixture } from '../../postgres/test/fixture.js'

test('real tarballs install independently with public types and runtime/import isolation', async () => {
  // Cover Windows short paths and user directories containing spaces without
  // depending on metadata cached by a previous package-manager invocation.
  const root = mkdtempSync(join(tmpdir(), 'fin-consumers~ '))
  const pnpm = process.env.npm_execpath
  if (!pnpm) throw new Error('Run this gate with pnpm exec vitest or pnpm test.')
  // Handles both the native pnpm 12 executable and Node-based pnpm distributions.
  const command = /\.[cm]?js$/.test(pnpm) ? process.execPath : pnpm
  const prefix = command === process.execPath ? [pnpm] : []
  const run = (args: string[], cwd: string) =>
    execFileSync(command, [...prefix, ...args], {
      cwd,
      encoding: 'utf8',
      timeout: 60000,
      stdio: 'pipe',
    })
  const storeDir = dirname(run(['store', 'path'], process.cwd()).trim())
  const postgres = process.env.FIN_POSTGRES_URL ? await openPostgresFixture() : undefined
  let neon: Awaited<ReturnType<typeof openNeonFixture>> | undefined
  try {
    if (process.env.FIN_NEON_URL) neon = await openNeonFixture()
    const overrides: Record<string, string> = {}
    for (const name of [
      'provider',
      'core',
      'sqlite',
      'd1',
      'tools',
      'turso',
      'supabase',
      'postgres',
      'neon',
    ]) {
      const tarball = join(root, `${name}.tgz`)
      run(['pack', '--out', tarball], resolve('packages', name))
      // Relative file paths avoid URL-encoding Windows short paths and spaces.
      // Every standalone consumer sits directly below the tarballs.
      overrides[`@fin/${name}`] = `file:../${name}.tgz`
    }
    for (const layout of ['core', 'worker', 'sqlite', 'turso', 'supabase', 'postgres', 'neon']) {
      const cwd = join(root, layout)
      mkdirSync(cwd)
      const dependencies: Record<string, string> =
        layout === 'turso' || layout === 'supabase'
          ? {
              [`@fin/${layout}`]: overrides[`@fin/${layout}`] ?? '',
              '@fin/core': overrides['@fin/core'] ?? '',
            }
          : { '@fin/core': overrides['@fin/core'] ?? '' }
      if (layout !== 'core' && layout !== 'turso' && layout !== 'supabase') {
        dependencies['@fin/tools'] = overrides['@fin/tools'] ?? ''
        dependencies[`@fin/${layout === 'worker' ? 'd1' : layout}`] =
          overrides[`@fin/${layout === 'worker' ? 'd1' : layout}`] ?? ''
      }
      if (layout === 'sqlite') dependencies['@modelcontextprotocol/server'] = '2.4.0'
      writeFileSync(
        join(cwd, 'package.json'),
        JSON.stringify({
          name: `consumer-${layout}`,
          type: 'module',
          private: true,
          dependencies,
          ...(['sqlite', 'postgres', 'neon'].includes(layout)
            ? { devDependencies: { '@types/node': '24.19.2' } }
            : {}),
        }),
      )
      writeFileSync(
        join(cwd, 'pnpm-workspace.yaml'),
        JSON.stringify({
          packages: [],
          cacheDir: join(root, 'cache'),
          allowBuilds: { 'better-sqlite3': true },
          overrides,
        }),
      )
      run(['install', '--prefer-offline', '--no-frozen-lockfile', '--store-dir', storeDir], cwd)
      if (layout === 'supabase') {
        for (const name of [
          '@fin/sqlite',
          '@fin/d1',
          '@fin/turso',
          '@fin/tools',
          'better-sqlite3',
          'drizzle-orm',
          'pg',
          '@modelcontextprotocol/server',
        ])
          expect(existsSync(join(cwd, 'node_modules', name))).toBe(false)
        expect(existsSync(join(cwd, 'node_modules/@fin/supabase/sql/001.sql'))).toBe(true)
        writeFileSync(
          join(cwd, 'consumer.mjs'),
          `
          import {strict as assert} from 'node:assert';
          import {createSupabaseAdapter} from '@fin/supabase';
          import {createFin,createVault} from '@fin/core';
          let calls=0, vault=null, settings=null, stamp=0;
          const real=!!process.env.FIN_PACKED_SUPABASE_URL;
          const transport=async(input,init)=>{
            calls++; assert.equal(init.redirect,'manual');
            if(real){
              const headers=new Headers(init.headers);
              if(process.env.FIN_PACKED_SUPABASE_JWT) headers.set('Authorization','Bearer '+process.env.FIN_PACKED_SUPABASE_JWT);
              let path=new URL(input).pathname;
              if(process.env.FIN_PACKED_SUPABASE_NAMESPACE) path=path.replace(/fin_supabase_(check_schema|context|commit)$/,process.env.FIN_PACKED_SUPABASE_NAMESPACE+'_$1');
              else path=path.replace('/rest/v1','');
              return fetch(process.env.FIN_PACKED_SUPABASE_URL+path,{...init,headers});
            }
            const body=JSON.parse(init.body), name=new URL(input).pathname.split('/').pop();
            const identity='FIN_SUPABASE_IDENTITY';
            if(name==='fin_supabase_check_schema')return Response.json({identity});
            if(name==='fin_supabase_context') return Response.json({identity,nonce:body.p_nonce,kind:body.p_request.kind,vaultId:body.p_request.vaultId??null,guard:vault?{generation:'g',stamp:String(stamp)}:null,counts:{vaults:0,accounts:0,categories:0,transactions:0,records:0},context:{vault,settings,vaults:[],accounts:[],categories:[],transactions:[],records:[]}});
            vault=body.p_changes.vault??vault;settings=body.p_changes.settings??settings;stamp++;
            return Response.json({identity,nonce:body.p_nonce,vaultId:vault.id,recordId:body.p_record.id,generation:body.p_guard.generation,stamp:String(stamp)});
          };
          const storage=createSupabaseAdapter({url:process.env.FIN_PACKED_SUPABASE_URL??'https://unused.invalid',apiKey:process.env.SUPABASE_TEST_SECRET_KEY??'sb_secret_test',fetch:transport});
          assert.equal(calls,0);assert.equal('close' in storage,false);assert.equal('migrate' in storage,false);
          await storage.checkSchema();
          await assert.rejects(import('@fin/supabase/context'),{code:'ERR_PACKAGE_PATH_NOT_EXPORTED'});
          const result=await createVault({storage,name:'Installed'});
          const fin=createFin({storage,vaultId:result.vault.id});
          assert.equal((await fin.getVault()).name,'Installed');
          assert.equal((await fin.updateVault({expectedRevision:result.vault.revision,patch:{name:'Renamed'}})).vault.name,'Renamed');
        `.replace('FIN_SUPABASE_IDENTITY', supabaseIdentity),
        )
      } else if (layout === 'turso') {
        for (const name of [
          '@fin/sqlite',
          '@fin/d1',
          '@fin/tools',
          'better-sqlite3',
          'drizzle-orm',
          '@modelcontextprotocol/server',
        ])
          expect(existsSync(join(cwd, 'node_modules', name))).toBe(false)
        writeFileSync(
          join(cwd, 'consumer.mjs'),
          `
          import { strict as assert } from 'node:assert';
          import { DatabaseSync } from 'node:sqlite';
          import { createTursoAdapter } from '@fin/turso';
          import { createFin, createVault, listVaults } from '@fin/core';
          const db = new DatabaseSync(':memory:');
          let calls = 0;
          globalThis.fetch = async (_, init) => {
            calls++;
            const { requests } = JSON.parse(init.body);
            const results = requests.map(r => {
              if (r.type === 'get_autocommit') return {type:'ok',response:{type:r.type,is_autocommit:!db.isTransaction}};
              if (r.type === 'close') { if(db.isTransaction) db.exec('ROLLBACK'); return {type:'ok',response:{type:r.type}}; }
              const statement = r.batch.steps[0].stmt;
              const stmt = db.prepare(statement.sql); stmt.setReadBigInts(true);
              const cols = stmt.columns().map(c=>({name:c.name,decltype:c.type}));
              const args = (statement.args ?? []).map(v=>v.type==='null'?null:v.type==='integer'?BigInt(v.value):v.value);
              let rows=[], affected=0, rowid=null;
              if (cols.length) rows=stmt.all(...args).map(row=>cols.map(c=>{
                const v=row[c.name]; return v===null?{type:'null'}:typeof v==='bigint'?{type:'integer',value:String(v)}:{type:typeof v==='string'?'text':'float',value:v};
              }));
              else { const info=stmt.run(...args); if(/^(INSERT|UPDATE|DELETE)/.test(statement.sql)){affected=Number(info.changes);rowid=String(info.lastInsertRowid);} }
              return {type:'ok',response:{type:'batch',result:{step_results:[{cols,rows,affected_row_count:affected,last_insert_rowid:rowid,rows_read:rows.length,rows_written:affected,query_duration_ms:0}],step_errors:[null]}}};
            });
            return Response.json({baton:requests[0].type==='close'?null:'owned',base_url:null,results});
          };
          const storage = createTursoAdapter({ url: 'https://not-contacted.invalid', authToken: 'unused' });
          assert.equal(calls, 0);
          await assert.rejects(import('@fin/turso/transport'), {code:'ERR_PACKAGE_PATH_NOT_EXPORTED'});
          try {
            await storage.migrate();
            const { vault } = await createVault({ storage, name:'Installed' });
            const fin = createFin({ storage, vaultId:vault.id });
            const { account } = await fin.createAccount({name:'Cash',nature:'asset',currency:'KRW'});
            const {transaction} = await fin.recordIncomeExpense({kind:'income',accountId:account.id,amountMinor:123,memo:'한글\\u0000🙂'});
            assert.equal((await fin.getAccount({id:account.id})).balanceMinor,123);
            assert.equal((await fin.listChangeRecords({targetId:transaction.id}))[0].after.transaction.id,transaction.id);
            assert.deepEqual(await listVaults({storage}),[vault]);
          } finally { await storage.close(); db.close(); }`,
        )
      } else if (layout === 'core') {
        expect(existsSync(join(cwd, 'node_modules/@fin/tools'))).toBe(false)
        writeFileSync(
          join(cwd, 'consumer.mjs'),
          `import { createFin } from '@fin/core';
          import { strict as assert } from 'node:assert';
          const fin = createFin({ storage: { read() { throw new Error('unexpected I/O') }, mutate() { throw new Error('unexpected I/O') } }, vaultId: 'opaque' });
          assert.equal(typeof fin.recordIncomeExpense, 'function');`,
        )
      } else if (layout === 'worker') {
        expect(existsSync(join(cwd, 'node_modules/@modelcontextprotocol/server'))).toBe(false)
        expect(existsSync(join(cwd, 'node_modules/@fin/sqlite'))).toBe(false)
        writeFileSync(
          join(cwd, 'consumer.mjs'),
          `import { createFin } from '@fin/core';
          import { createD1Adapter } from '@fin/d1'; import { createFinTools } from '@fin/tools';
          const storage = createD1Adapter({ accountId: 'test', databaseId: 'test', apiToken: 'test', fetch() { throw new Error('unexpected I/O') } });
          const fin = createFin({ storage, vaultId: 'opaque' });
          const tools = createFinTools({ tools: ['balances.query'] });
          if (typeof fin.queryBalances !== 'function' || !tools['balances.query']) throw new Error('Missing API');`,
        )
      } else if (layout === 'neon') {
        for (const name of ['pg', '@fin/postgres', '@fin/sqlite', '@fin/d1', 'better-sqlite3'])
          expect(existsSync(join(cwd, `node_modules/${name}`))).toBe(false)
        writeFileSync(
          join(cwd, 'consumer.mjs'),
          `
          import { strict as assert } from 'node:assert';
          import { createFin, createVault } from '@fin/core';
          import { createNeonAdapter } from '@fin/neon';
          import { createFinTools } from '@fin/tools';
          const url = process.env.FIN_NEON_CONSUMER_URL;
          const proxy = process.env.FIN_NEON_CONSUMER_WS;
          if (proxy) {
            const NativeWebSocket = globalThis.WebSocket;
            globalThis.WebSocket = class extends NativeWebSocket {
              constructor(address, protocols) { super(new URL(address).hostname === new URL(url).hostname ? proxy : address, protocols); }
            };
          }
          // Import resolution also proves no transitive standalone pg runtime is installed.
          assert.throws(() => import.meta.resolve('pg'));
          const storage = createNeonAdapter({ connectionString: url || 'postgres://user@127.0.0.1:1/no-network' });
          try {
            if (url) {
              const { vault } = await createVault({ storage, name: 'Packed Neon' });
              const fin = createFin({ storage, vaultId: vault.id });
              const tools = createFinTools({ access: { getFin: async () => fin } });
              const { account } = await tools['accounts.create'].execute({ vaultId: vault.id, name: 'Cash', nature: 'asset', currency: 'KRW' });
              await fin.recordIncomeExpense({ kind: 'income', accountId: account.id, amountMinor: 321 });
              assert.equal((await fin.getAccount({ id: account.id })).balanceMinor, 321);
              assert.equal((await fin.listChangeRecords()).length, 3);
              await assert.rejects(tools['accounts.create'].execute({ vaultId: vault.id, name: 'Cash', nature: 'asset', currency: 'KRW' }), {code:'INVALID_INPUT'});
            }
          } finally { const closed=storage.close(); assert.equal(storage.close(),closed); await closed; }
        `,
        )
      } else if (layout === 'postgres') {
        expect(existsSync(join(cwd, 'node_modules/@fin/sqlite'))).toBe(false)
        expect(existsSync(join(cwd, 'node_modules/better-sqlite3'))).toBe(false)
        expect(existsSync(join(cwd, 'node_modules/@fin/d1'))).toBe(false)
        writeFileSync(
          join(cwd, 'consumer.mjs'),
          `
          import { strict as assert } from 'node:assert';
          import { createFin, createVault } from '@fin/core';
          import { createPostgresAdapter } from '@fin/postgres';
          const url = process.env.FIN_POSTGRES_CONSUMER_URL;
          const storage = createPostgresAdapter({ connectionString: url || 'postgres://user@127.0.0.1:1/no-network' });
          try {
            if (url) {
              const { vault } = await createVault({ storage, name: 'Packed PostgreSQL' });
              const fin = createFin({ storage, vaultId: vault.id });
              const { account } = await fin.createAccount({ name: 'Cash', nature: 'asset', currency: 'KRW' });
              await fin.recordIncomeExpense({ kind: 'income', accountId: account.id, amountMinor: 321 });
              assert.equal((await fin.getAccount({ id: account.id })).balanceMinor, 321);
              assert.equal((await fin.listChangeRecords()).length, 3);
            }
          } finally { await storage.close(); }
        `,
        )
      } else {
        writeFileSync(
          join(cwd, 'consumer.mjs'),
          `import { strict as assert } from 'node:assert';
          import { createFin, createVault, listVaults } from '@fin/core'; import { createSqliteAdapter } from '@fin/sqlite';
          import { createFinTools } from '@fin/tools'; import { registerFinTools } from '@fin/tools/mcp'; import { McpServer } from '@modelcontextprotocol/server';
          const storage = createSqliteAdapter({ filename: ':memory:' });
          try {
            const access = { listVaults: options => listVaults({ storage, ...options }), createVault: input => createVault({ storage, ...input }), getFin: async vaultId => createFin({ storage, vaultId }) };
            const tools = createFinTools({ access });
            assert.deepEqual(await tools['vaults.list'].execute({}), []);
            const { vault } = await tools['vaults.create'].execute({ name: 'Installed' });
            const { account } = await tools['accounts.create'].execute({ vaultId: vault.id, name: 'Cash', nature: 'asset', currency: 'KRW' });
            assert.equal(account.balanceMinor, 0);
            const server = new McpServer({ name: 'installed', version: '0.0.0' }); registerFinTools(server, tools); await server.close();
          } finally { await storage.close() }`,
        )
      }
      const actualSupabase =
        layout === 'supabase' &&
        (process.env.FIN_SUPABASE_LOCAL === '1' || process.env.FIN_SUPABASE_HOSTED === '1')
          ? await openSupabaseFixture()
          : undefined
      try {
        await new Promise<void>((resolve, reject) =>
          execFile(
            process.execPath,
            ['consumer.mjs'],
            {
              cwd,
              encoding: 'utf8',
              timeout: layout === 'neon' ? 120000 : 15000,
              env: {
                ...process.env,
                FIN_NEON_CONSUMER_URL: neon?.connectionString,
                FIN_NEON_CONSUMER_WS: neon?.webSocketUrl,
                FIN_POSTGRES_CONSUMER_URL: postgres?.connectionString,
                ...(actualSupabase
                  ? {
                      FIN_PACKED_SUPABASE_URL: actualSupabase.base,
                      FIN_PACKED_SUPABASE_JWT: actualSupabase.hosted
                        ? ''
                        : actualSupabase.token('service_role'),
                      FIN_PACKED_SUPABASE_NAMESPACE: actualSupabase.hosted
                        ? actualSupabase.namespace
                        : '',
                    }
                  : {}),
              },
            },
            (error) => (error ? reject(error) : resolve()),
          ),
        )
      } finally {
        await actualSupabase?.dispose()
      }
      if (layout === 'core' || layout === 'worker') {
        const bundle = await build({
          entryPoints: [join(cwd, 'consumer.mjs')],
          bundle: true,
          format: 'esm',
          platform: 'browser',
          conditions: ['workerd'],
          write: false,
          // The core consumer's only Node import is its test assertion, not library code.
          external: layout === 'core' ? ['node:assert'] : [],
          metafile: true,
        })
        const imports = Object.keys(bundle.metafile.inputs)
        expect(
          imports.some((path) =>
            /node_modules\/(?:better-sqlite3|@modelcontextprotocol)\//.test(path),
          ),
        ).toBe(false)
        if (layout === 'core')
          expect(imports.some((path) => /node_modules\/(?:drizzle-orm|zod)\//.test(path))).toBe(
            false,
          )
      }
      const types =
        layout === 'supabase'
          ? `import {createSupabaseAdapter,type SupabaseAdapterOptions} from '@fin/supabase';
          import {createFin,type FinStorage} from '@fin/core';
          const options={url:'https://unused.invalid',apiKey:'sb_secret_test'} satisfies SupabaseAdapterOptions;
          const storage=createSupabaseAdapter(options);const seam:FinStorage=storage;void seam;
          const checked:Promise<void>=storage.checkSchema();void checked;
          const vault:Promise<{id:string}>=createFin({storage,vaultId:'v'}).getVault();void vault;
          // @ts-expect-error Supabase runtime is check-only, no schema installation.
          storage.migrate();
          // @ts-expect-error Stateless HTTP adapter has no empty close API.
          storage.close();
          // @ts-expect-error Clients are owned internally.
          createSupabaseAdapter({client:{}});
          // @ts-expect-error Internal wire validation is not public.
          import {readContext} from '@fin/supabase/context';`
          : layout === 'turso'
            ? `import { createTursoAdapter, type TursoAdapterOptions } from '@fin/turso';
          import { createFin, type FinStorage } from '@fin/core';
          const options = { url: 'https://unused.invalid', authToken: 'unused', autoMigrate: false } satisfies TursoAdapterOptions;
          const storage = createTursoAdapter(options);
          const seam: FinStorage = storage; void seam;
          const account: Promise<{ balanceMinor: number }> = createFin({storage,vaultId:'opaque'}).getAccount({id:'opaque'}); void account;
          const prepared: Promise<void> = storage.migrate(); void prepared;
          const closed: Promise<void> = storage.close(); void closed;
          // @ts-expect-error Runtime clients are owned internally, not supplied.
          createTursoAdapter({client:{}});
          // @ts-expect-error There is no public transport subpath.
          import { TursoTransport } from '@fin/turso/transport';`
            : layout === 'core'
              ? `import { createFin, type FinStorage } from '@fin/core';
        declare const storage: FinStorage; const fin = createFin({ storage, vaultId: 'opaque' });
        const account: Promise<{ balanceMinor: number }> = fin.getAccount({ id: 'opaque' }); void account;`
              : `import { createFinTools } from '@fin/tools';
        const tools = createFinTools({ tools: ['vaults.list', 'accounts.create'] });
        const result: Promise<{ account: { balanceMinor: number } }> = tools['accounts.create'].execute({ vaultId: 'opaque', name: 'Cash', nature: 'asset', currency: 'KRW' }); void result;
        // @ts-expect-error Unselected tool is absent from the public type.
        tools['transactions.delete'];
        // @ts-expect-error Financial calls require an explicit Vault ID.
        tools['accounts.create'].execute({ name: 'Cash', nature: 'asset', currency: 'KRW' });
        // @ts-expect-error Unknown tool selectors cannot compile.
        createFinTools({ tools: ['missing'] });`
      const providerTypes =
        layout === 'worker'
          ? `import { createD1Adapter } from '@fin/d1'; import type { FinStorage } from '@fin/core';
          const storage: FinStorage = createD1Adapter({ accountId: 'test', databaseId: 'test', apiToken: 'test' }); void storage;`
          : layout === 'neon'
            ? `import { createNeonAdapter, type NeonAdapterOptions } from '@fin/neon'; import type { FinStorage } from '@fin/core';
            const options = { connectionString: 'postgres://localhost/test', autoMigrate: false } satisfies NeonAdapterOptions;
            const adapter = createNeonAdapter(options); const storage: FinStorage = adapter; void storage;
            const prepared: Promise<void> = adapter.migrate(); void prepared;
            const closed: Promise<void> = adapter.close(); void closed;
            // @ts-expect-error Clients are owned internally.
            createNeonAdapter({ client: {} });
            // @ts-expect-error No public session subpath.
            import { NeonSession } from '@fin/neon/session';`
            : layout === 'postgres'
              ? `import { createPostgresAdapter } from '@fin/postgres'; import type { FinStorage } from '@fin/core';
            const adapter = createPostgresAdapter({ connectionString: 'postgres://localhost/test', autoMigrate: false });
            const storage: FinStorage = adapter; void storage;
            const prepared: Promise<void> = adapter.migrate(); void prepared;
            const closed: Promise<void> = adapter.close(); void closed;`
              : layout === 'sqlite'
                ? `import { createSqliteAdapter } from '@fin/sqlite'; import { registerFinTools } from '@fin/tools/mcp';
            import { McpServer } from '@modelcontextprotocol/server';
            const storage = createSqliteAdapter({ filename: ':memory:' });
            const closed: Promise<void> = storage.close(); void closed;
            registerFinTools(new McpServer({ name: 'typed', version: '0.0.0' }), tools);`
                : ''
      writeFileSync(join(cwd, 'consumer.ts'), types + '\n' + providerTypes)
      execFileSync(
        process.execPath,
        [
          resolve('node_modules/typescript/bin/tsc'),
          '--noEmit',
          '--strict',
          '--module',
          'NodeNext',
          '--target',
          'ES2023',
          ...(['sqlite', 'postgres', 'neon'].includes(layout) ? ['--types', 'node'] : []),
          'consumer.ts',
        ],
        { cwd, encoding: 'utf8', timeout: 15000, stdio: 'inherit' },
      )
    }
  } finally {
    await neon?.dispose()
    await postgres?.dispose()
    rmSync(root, { recursive: true, force: true })
  }
}, 300000)
