import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { build } from 'esbuild'
import { expect, test } from 'vitest'

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
  try {
    const overrides: Record<string, string> = {}
    for (const name of ['provider', 'core', 'sqlite', 'd1', 'tools', 'turso']) {
      const tarball = join(root, `${name}.tgz`)
      run(['pack', '--out', tarball], resolve('packages', name))
      // Relative file paths avoid URL-encoding Windows short paths and spaces.
      // Every standalone consumer sits directly below the tarballs.
      overrides[`@fin/${name}`] = `file:../${name}.tgz`
    }
    for (const layout of ['core', 'worker', 'sqlite', 'turso']) {
      const cwd = join(root, layout)
      mkdirSync(cwd)
      const dependencies: Record<string, string> =
        layout === 'turso'
          ? {
              '@fin/turso': overrides['@fin/turso'] ?? '',
              '@fin/core': overrides['@fin/core'] ?? '',
            }
          : { '@fin/core': overrides['@fin/core'] ?? '' }
      if (layout !== 'core' && layout !== 'turso') {
        dependencies['@fin/tools'] = overrides['@fin/tools'] ?? ''
        dependencies[`@fin/${layout === 'worker' ? 'd1' : 'sqlite'}`] =
          overrides[`@fin/${layout === 'worker' ? 'd1' : 'sqlite'}`] ?? ''
      }
      if (layout === 'sqlite') dependencies['@modelcontextprotocol/server'] = '2.4.0'
      writeFileSync(
        join(cwd, 'package.json'),
        JSON.stringify({
          name: `consumer-${layout}`,
          type: 'module',
          private: true,
          dependencies,
          ...(layout === 'sqlite' ? { devDependencies: { '@types/node': '24.19.2' } } : {}),
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
      if (layout === 'turso') {
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
          const storage = createTursoAdapter({ url: 'https://not-contacted.invalid', authToken: 'unused', fetch: async (_, init) => {
            calls++; assert.equal(init.redirect, 'manual');
            const { requests } = JSON.parse(init.body);
            const results = requests.map(r => {
              if (r.type === 'get_autocommit') return {type:'ok',response:{type:r.type,is_autocommit:!db.isTransaction}};
              if (r.type === 'close') { if(db.isTransaction) db.exec('ROLLBACK'); return {type:'ok',response:{type:r.type}}; }
              const stmt = db.prepare(r.stmt.sql); stmt.setReadBigInts(true);
              const cols = stmt.columns().map(c=>({name:c.name,decltype:c.type}));
              const args = (r.stmt.args ?? []).map(v=>v.type==='null'?null:v.type==='integer'?BigInt(v.value):v.value);
              let rows=[], affected=0, rowid=null;
              if (cols.length) rows=stmt.all(...args).map(row=>cols.map(c=>{
                const v=row[c.name]; return v===null?{type:'null'}:typeof v==='bigint'?{type:'integer',value:String(v)}:{type:typeof v==='string'?'text':'float',value:v};
              }));
              else { const info=stmt.run(...args); if(/^(INSERT|UPDATE|DELETE)/.test(r.stmt.sql)){affected=Number(info.changes);rowid=String(info.lastInsertRowid);} }
              return {type:'ok',response:{type:r.type,result:{cols,rows,affected_row_count:affected,last_insert_rowid:rowid,rows_read:rows.length,rows_written:affected,query_duration_ms:0}}};
            });
            return Response.json({baton:requests[0].type==='close'?null:'owned',base_url:null,results});
          } });
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
      execFileSync(process.execPath, ['consumer.mjs'], { cwd, encoding: 'utf8', timeout: 15000 })
      if (layout !== 'sqlite' && layout !== 'turso') {
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
        layout === 'turso'
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
          ...(layout === 'sqlite' ? ['--types', 'node'] : []),
          'consumer.ts',
        ],
        { cwd, encoding: 'utf8', timeout: 15000, stdio: 'inherit' },
      )
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 180000)
