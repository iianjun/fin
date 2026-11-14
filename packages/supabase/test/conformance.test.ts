import { Client } from 'pg'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { createFin, createVault, listVaults } from '@fin-kit/core'
import type { ChangeRecord, MutationDecision } from '@fin-kit/provider'
import { openSupabaseFixture } from './fixture.js'
import { identity } from '../src/context.js'

const disposers: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
})
async function fixture(options?: { install?: boolean; scoped?: boolean }) {
  const f = await openSupabaseFixture(options)
  disposers.push(f.dispose)
  return f
}

describe.skipIf(process.env.FIN_SUPABASE_LOCAL !== '1' && process.env.FIN_SUPABASE_HOSTED !== '1')(
  'Supabase real PostgreSQL/PostgREST conformance',
  () => {
    test('administrator installation, runtime check-only readiness, grants and schema-cache reload', async () => {
      const f = await fixture({ install: false, scoped: true })
      await f.admin.query(
        "CREATE TABLE public.host_data(value text); INSERT INTO public.host_data VALUES ('keep')",
      )
      await expect(f.storage.checkSchema()).rejects.toMatchObject({ code: 'SCHEMA_INCOMPATIBLE' })
      expect(
        (await f.admin.query("SELECT nspname FROM pg_namespace WHERE nspname='fin_supabase'")).rows,
      ).toEqual([])
      await f.admin.query(f.sql)
      // Read-only readiness polling is test setup; adapter calls never retry.
      let ready = false
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          await f.storage.checkSchema()
          ready = true
          break
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      expect(ready).toBe(true)
      await Promise.all([f.storage.checkSchema(), f.client().checkSchema()])
      expect(await listVaults({ storage: f.storage })).toEqual([])
      expect((await f.admin.query('SELECT * FROM public.host_data')).rows).toEqual([
        { value: 'keep' },
      ])
      const checks = await f.admin.query(`SELECT
      has_function_privilege('service_role','public.fin_supabase_commit(jsonb,jsonb,jsonb,jsonb,text)','execute') AS service_rpc,
      has_function_privilege('anon','public.fin_supabase_commit(jsonb,jsonb,jsonb,jsonb,text)','execute') AS anon_rpc,
      has_function_privilege('authenticated','public.fin_supabase_context(jsonb,text)','execute') AS user_rpc,
      has_schema_privilege('service_role','fin_supabase','usage') AS service_tables,
      has_function_privilege('service_role','fin_supabase.fingerprint()','execute') AS service_internal`)
      expect(checks.rows).toEqual([
        {
          service_rpc: true,
          anon_rpc: false,
          user_rpc: false,
          service_tables: false,
          service_internal: false,
        },
      ])
      for (const role of f.hosted ? [] : ['anon', 'authenticated']) {
        const response = await fetch(`${f.rpcBase}/rpc/${f.namespace}_check_schema`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${f.token(role)}`, 'Content-Type': 'application/json' },
          body: '{}',
        })
        expect([401, 403, 404]).toContain(response.status)
      }
    })

    test('failed installation rolls all DDL back; repeated or partial installation cannot overwrite data', async () => {
      const f = await fixture({ install: false })
      await expect(
        f.admin.query(f.sql.replace('COMMIT;', 'SELECT 1/0; COMMIT;')),
      ).rejects.toMatchObject({ code: '22012' })
      await f.admin.query('ROLLBACK')
      expect(
        (await f.admin.query("SELECT nspname FROM pg_namespace WHERE nspname='fin_supabase'")).rows,
      ).toEqual([])
      await f.admin.query(f.sql)
      await expect(f.admin.query(f.sql)).rejects.toMatchObject({ code: '42P06' })
      await f.admin.query('ROLLBACK')
      expect(
        (await f.admin.query('SELECT version,identity FROM fin_supabase.migrations')).rows,
      ).toEqual([{ version: 1, identity }])
    })

    test('independent administrator installs serialize; the losing install cannot repair or overwrite', async () => {
      const f = await fixture({ install: false })
      const url = new URL(process.env.SUPABASE_TEST_DATABASE_URL ?? '')
      if (!f.hosted) url.pathname = `/${f.databaseName}`
      const other = new Client({ connectionString: url.href })
      await other.connect()
      try {
        const outcomes = await Promise.allSettled([f.admin.query(f.sql), other.query(f.sql)])
        expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
        const failed = outcomes.find((r) => r.status === 'rejected')
        expect(failed?.reason).toMatchObject({ code: '42P06' })
        await f.admin.query('ROLLBACK')
        await other.query('ROLLBACK')
        expect(
          (await f.admin.query('SELECT version,identity FROM fin_supabase.migrations')).rows,
        ).toEqual([{ version: 1, identity }])
      } finally {
        await other.end()
      }
    })

    test.each(['identity', 'column', 'constraint', 'function', 'privilege', 'trigger', 'partial'])(
      'rejects %s drift after readiness without repairing existing data',
      async (kind) => {
        const f = await fixture()
        const { vault } = await createVault({ storage: f.storage, name: 'Preserved' })
        await f.storage.checkSchema()
        const before = (await f.admin.query('SELECT payload FROM fin_supabase.history')).rows
        const mutations: Record<string, string> = {
          identity: "UPDATE fin_supabase.migrations SET identity='unknown'",
          column: 'ALTER TABLE fin_supabase.accounts ADD COLUMN unknown text',
          constraint: 'ALTER TABLE fin_supabase.vaults DROP CONSTRAINT vaults_stamp_check',
          function:
            'ALTER FUNCTION public.fin_supabase_context(jsonb,text) SET statement_timeout=1000',
          privilege:
            'GRANT EXECUTE ON FUNCTION public.fin_supabase_commit(jsonb,jsonb,jsonb,jsonb,text) TO anon',
          trigger:
            'CREATE FUNCTION fin_supabase.test_trigger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$; CREATE TRIGGER unknown BEFORE UPDATE ON fin_supabase.accounts FOR EACH ROW EXECUTE FUNCTION fin_supabase.test_trigger()',
          partial: 'DROP TABLE fin_supabase.assignments',
        }
        const sql = mutations[kind]
        if (!sql) throw new Error('Missing drift')
        await f.admin.query(sql)
        await expect(f.storage.checkSchema()).rejects.toMatchObject({
          code: 'SCHEMA_INCOMPATIBLE',
          application: 'not_applied',
        })
        await expect(
          createFin({ storage: f.storage, vaultId: vault.id }).createAccount({
            name: 'Rejected',
            nature: 'asset',
            currency: 'KRW',
          }),
        ).rejects.toMatchObject({ code: 'SCHEMA_INCOMPATIBLE' })
        expect((await f.admin.query('SELECT payload FROM fin_supabase.history')).rows).toEqual(
          before,
        )
      },
    )

    test.each(['name', 'duplicate', 'aggregate', 'category', 'settings'])(
      'independent clients guard %s predicates at the same complete context',
      async (race) => {
        const f = await fixture()
        const { vault } = await createVault({ storage: f.storage, name: 'Race' })
        const seed = createFin({ storage: f.storage, vaultId: vault.id })
        const a = (await seed.createAccount({ name: 'Cash', nature: 'asset', currency: 'KRW' }))
          .account
        const s = await seed.getSettings()
        let contexts = 0,
          release = () => {}
        const barrier = new Promise<void>((resolve) => {
          release = resolve
        })
        const transport: typeof fetch = async (input, init) => {
          const response = await f.fetch(input, init)
          if (String(input).endsWith('fin_supabase_context')) {
            contexts++
            if (contexts === 2) release()
            await barrier
          }
          return response
        }
        const [first, other] = [0, 1].map(() =>
          createFin({ storage: f.client({ fetch: transport }), vaultId: vault.id }),
        )
        if (!first || !other) throw new Error('Missing clients')
        let operations: (() => Promise<unknown>)[]
        if (race === 'name')
          operations = [first, other].map(
            (fin) => () => fin.createAccount({ name: 'Raced', nature: 'asset', currency: 'KRW' }),
          )
        else if (race === 'duplicate')
          operations = [first, other].map(
            (fin) => () =>
              fin.recordIncomeExpense({
                kind: 'expense',
                accountId: a.id,
                amountMinor: 1,
                memo: 'same',
              }),
          )
        else if (race === 'aggregate') {
          await seed.recordIncomeExpense({
            kind: 'income',
            accountId: a.id,
            amountMinor: Number.MAX_SAFE_INTEGER - 1,
          })
          operations = [first, other].map(
            (fin, i) => () =>
              fin.recordIncomeExpense({
                kind: 'income',
                accountId: a.id,
                amountMinor: 1,
                memo: String(i),
              }),
          )
        } else if (race === 'category') {
          const parent = (await seed.createCategory({ name: 'Parent' })).category
          const child = (await seed.createCategory({ name: 'Child', parentId: parent.id })).category
          const destination = (await seed.createCategory({ name: 'Destination' })).category
          operations = [
            () =>
              first.updateCategory({
                id: parent.id,
                expectedRevision: parent.revision,
                patch: { parentId: destination.id },
              }),
            () => other.createCategory({ name: 'Leaf', parentId: child.id }),
          ]
        } else
          operations = [
            () =>
              first.setDefaultAccount({
                kind: 'income',
                accountId: a.id,
                expectedRevision: s.revision,
              }),
            () =>
              other.updateAccount({
                id: a.id,
                expectedRevision: a.revision,
                patch: { archived: true },
              }),
          ]
        const outcomes = await Promise.allSettled(operations.map((run) => run()))
        expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
        const failed = outcomes.find((r) => r.status === 'rejected')
        expect(failed?.reason).toMatchObject({ code: 'CONFLICT', application: 'not_applied' })
        if (race === 'name')
          expect((await seed.listAccounts()).filter((a) => a.name === 'Raced')).toHaveLength(1)
        if (race === 'duplicate') expect(await seed.listTransactions()).toHaveLength(1)
        if (race === 'aggregate')
          expect((await seed.getAccount({ id: a.id })).balanceMinor).toBe(Number.MAX_SAFE_INTEGER)
        if (race === 'category')
          expect((await seed.listCategories()).every((c) => c.path.split(' / ').length <= 3)).toBe(
            true,
          )
        if (race === 'settings')
          expect(
            !(await seed.getAccount({ id: a.id })).archived ||
              (await seed.getSettings()).incomeAccountId === null,
          ).toBe(true)
      },
    )

    test.each(['unrelated', 'generation', 'aba'])(
      '%s changes invalidate the whole stale plan, preserving independent changes',
      async (race) => {
        const f = await fixture(),
          { vault } = await createVault({ storage: f.storage, name: 'Guard' })
        const fin = createFin({ storage: f.storage, vaultId: vault.id })
        const a = (await fin.createAccount({ name: 'A', nature: 'asset', currency: 'KRW' })).account
        const b = (await fin.createAccount({ name: 'B', nature: 'asset', currency: 'KRW' })).account
        const storage = f.client({
          fetch: async (input, init) => {
            const response = await f.fetch(input, init)
            if (String(input).endsWith('fin_supabase_context')) {
              if (race === 'generation')
                await f.admin.query(
                  "UPDATE fin_supabase.vaults SET generation='replacement' WHERE id=$1",
                  [vault.id],
                )
              else {
                const changed = await fin.updateAccount({
                  id: b.id,
                  expectedRevision: b.revision,
                  patch: { name: 'B changed' },
                })
                if (race === 'aba')
                  await fin.updateAccount({
                    id: b.id,
                    expectedRevision: changed.account.revision,
                    patch: { name: 'B' },
                  })
              }
            }
            return response
          },
        })
        await expect(
          createFin({ storage, vaultId: vault.id }).updateAccount({
            id: a.id,
            expectedRevision: a.revision,
            patch: { name: 'Rejected' },
          }),
        ).rejects.toMatchObject({ code: 'CONFLICT', application: 'not_applied' })
        expect(await fin.getAccount({ id: a.id })).toEqual(a)
        expect(await fin.listChangeRecords({ targetId: a.id })).toHaveLength(1)
        expect((await fin.getAccount({ id: b.id })).name).toBe(
          race === 'unrelated' ? 'B changed' : 'B',
        )
      },
    )

    test.each(['edit', 'delete', 'classify', 'adjust'])(
      'late history failure rolls back %s state, edges, revisions and stamp',
      async (operation) => {
        const f = await fixture(),
          { vault } = await createVault({ storage: f.storage, name: 'Rollback' })
        const fin = createFin({ storage: f.storage, vaultId: vault.id })
        const a = (await fin.createAccount({ name: 'Cash', nature: 'asset', currency: 'KRW' }))
          .account
        const c = (await fin.createCategory({ name: 'Food' })).category
        const t = (
          await fin.recordIncomeExpense({ kind: 'expense', accountId: a.id, amountMinor: 100 })
        ).transaction
        const before = await fin.getAccount({ id: a.id }),
          records = await fin.listChangeRecords()
        const stamp = (
          await f.admin.query('SELECT stamp FROM fin_supabase.vaults WHERE id=$1', [vault.id])
        ).rows
        const storage = f.client({
          fetch: async (input, init) => {
            if (String(input).endsWith('fin_supabase_commit')) {
              const body = JSON.parse(String(init?.body))
              body.p_record.id = records[0]?.id
              return f.fetch(input, { ...init, body: JSON.stringify(body) })
            }
            return f.fetch(input, init)
          },
        })
        const failing = createFin({ storage, vaultId: vault.id })
        const input = { id: t.id, expectedRevision: t.revision }
        const pending =
          operation === 'edit'
            ? failing.editTransaction({ ...input, patch: { amountMinor: 500 } })
            : operation === 'delete'
              ? failing.deleteTransaction(input)
              : operation === 'classify'
                ? failing.setCategoryAssignments({
                    ...input,
                    assignments: [{ categoryId: c.id, amountMinor: 100, origin: 'explicit' }],
                  })
                : failing.adjustAccountBalance({
                    accountId: a.id,
                    expectedRevision: before.balanceRevision,
                    targetBalanceMinor: 0,
                  })
        await expect(pending).rejects.toMatchObject({
          code: 'STORAGE_FAILURE',
          application: 'not_applied',
        })
        expect(await fin.getAccount({ id: a.id })).toEqual(before)
        expect(await fin.getTransaction({ id: t.id })).toEqual(t)
        expect(await fin.listChangeRecords()).toEqual(records)
        expect(
          (await f.admin.query('SELECT stamp FROM fin_supabase.vaults WHERE id=$1', [vault.id]))
            .rows,
        ).toEqual(stamp)
      },
    )

    test.each(['lost', 'truncated', 'mismatch', 'redirect', 'gateway'])(
      'actual committed state and exact supplied history survive %s receipt: one decision/submission',
      async (fault) => {
        const f = await fixture(),
          { vault } = await createVault({ storage: f.storage, name: 'Ack' })
        let submissions = 0
        const storage = f.client({
          fetch: async (input, init) => {
            const response = await f.fetch(input, init)
            if (!String(input).endsWith('fin_supabase_commit')) return response
            submissions++
            expect(response.status).toBe(200)
            if (fault === 'lost') throw new Error('Dropped after actual commit')
            if (fault === 'truncated') return new Response('{')
            if (fault === 'redirect')
              return new Response(null, {
                status: 307,
                headers: { Location: 'https://other.invalid' },
              })
            if (fault === 'gateway') return Response.json({ message: 'gateway' }, { status: 502 })
            const value = await response.json()
            value.recordId = 'wrong'
            return Response.json(value)
          },
        })
        const result = { ...vault, name: '한글 🙂', revision: 'supplied-r' }
        const record: ChangeRecord = {
          id: crypto.randomUUID(),
          vaultId: vault.id,
          target: 'vault',
          targetId: vault.id,
          action: 'updated',
          recordedAt: '2026-11-08T00:00:00.000Z',
          before: vault,
          after: result,
          balances: [],
        }
        const decide = vi.fn(
          () =>
            ({
              kind: 'changed',
              changes: { vault: result },
              record,
              result,
            }) satisfies MutationDecision<typeof result>,
        )
        await expect(
          storage.mutate({ kind: 'vault', vaultId: vault.id }, decide),
        ).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN', application: 'unknown' })
        expect(submissions).toBe(1)
        expect(decide).toHaveBeenCalledTimes(1)
        expect(
          (await f.admin.query('SELECT payload FROM fin_supabase.vaults WHERE id=$1', [vault.id]))
            .rows[0]?.payload,
        ).toEqual(result)
        expect(
          (
            await f.admin.query(
              'SELECT payload FROM fin_supabase.history WHERE vault_id=$1 AND id=$2',
              [vault.id, record.id],
            )
          ).rows[0]?.payload,
        ).toEqual(record)
      },
    )

    test('direct commit RPC without a request kind still enforces the Vault scope', async () => {
      const f = await fixture(),
        { vault } = await createVault({ storage: f.storage, name: 'Scope' })
      await expect(
        f.admin.query('SELECT public.fin_supabase_commit($1,$2,$3,$4,$5)', [
          { vaultId: 'other' },
          { generation: 'g', stamp: '1' },
          {},
          { vaultId: vault.id },
          'nonce',
        ]),
      ).rejects.toThrow('fin invalid scope')
    })

    test('coherent multi-table context while independent commits change state and history', async () => {
      const f = await fixture(),
        { vault } = await createVault({ storage: f.storage, name: 'Snapshot' })
      const fin = createFin({ storage: f.storage, vaultId: vault.id })
      const a = (await fin.createAccount({ name: 'Cash', nature: 'asset', currency: 'KRW' }))
        .account
      let t = (await fin.recordIncomeExpense({ kind: 'income', accountId: a.id, amountMinor: 1 }))
        .transaction
      const writer = (async () => {
        for (let i = 2; i <= 12; i++)
          t = (
            await fin.editTransaction({
              id: t.id,
              expectedRevision: t.revision,
              patch: { amountMinor: i },
            })
          ).transaction
      })()
      for (let i = 0; i < 12; i++) {
        const context = await f.client().read({ kind: 'history', vaultId: vault.id, limit: 100 })
        const current = context.transactions[0]
        const latest = context.records.filter((r) => r.target === 'transaction').at(-1)
        expect(latest?.after).toMatchObject({ transaction: current })
        expect(context.accounts[0]?.balanceMinor).toBe(
          current && 'amountMinor' in current ? current.amountMinor : undefined,
        )
      }
      await writer
    })
    test('preserves JavaScript text code units, exact records and safe aggregate rejection', async () => {
      const f = await fixture(),
        name = 'NUL:\u0000 slash:\\ pair:🙂 lone:\ud800'
      const { vault } = await createVault({ storage: f.storage, name })
      const fin = createFin({ storage: f.storage, vaultId: vault.id })
      expect(await fin.getVault()).toEqual(vault)
      expect((await fin.listChangeRecords())[0]?.after).toEqual(vault)
      const a = (await fin.createAccount({ name, nature: 'asset', currency: 'KRW' })).account
      await fin.recordIncomeExpense({
        kind: 'income',
        accountId: a.id,
        amountMinor: Number.MAX_SAFE_INTEGER,
        memo: name,
      })
      const t = (await fin.listTransactions())[0]
      expect(t?.memo).toBe(name)
      await f.admin.query(
        'INSERT INTO fin_supabase.transactions(vault_id,payload) VALUES ($1,$2)',
        [
          vault.id,
          {
            id: 'overflow',
            revision: 'r',
            kind: 'income',
            occurredOn: '2026-11-08',
            memo: null,
            accountId: a.id,
            amountMinor: 1,
            assignments: [],
            relations: [],
          },
        ],
      )
      await expect(fin.getAccount({ id: a.id })).rejects.toMatchObject({
        code: 'STORAGE_FAILURE',
        application: 'not_applied',
      })
    })

    test('check-only, unchanged and failing decisions perform no financial SQL or commit RPC', async () => {
      const f = await fixture(),
        { vault } = await createVault({ storage: f.storage, name: 'No-op' })
      const before = (
        await f.admin.query('SELECT payload,generation,stamp FROM fin_supabase.vaults')
      ).rows
      let commits = 0
      const storage = f.client({
        fetch: async (input, init) => {
          if (String(input).endsWith('fin_supabase_commit')) commits++
          return f.fetch(input, init)
        },
      })
      await storage.checkSchema()
      const result = { same: true }
      expect(
        await storage.mutate({ kind: 'vault', vaultId: vault.id }, () => ({
          kind: 'unchanged',
          result,
        })),
      ).toBe(result)
      const error = new Error('Domain decision failure')
      await expect(
        storage.mutate({ kind: 'vault', vaultId: vault.id }, () => {
          throw error
        }),
      ).rejects.toBe(error)
      expect(commits).toBe(0)
      expect(
        (await f.admin.query('SELECT payload,generation,stamp FROM fin_supabase.vaults')).rows,
      ).toEqual(before)
      expect(
        (await f.admin.query('SELECT count(*) FROM fin_supabase.history')).rows[0]?.count,
      ).toBe('1')
    })
  },
)
