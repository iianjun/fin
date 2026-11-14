import { afterEach, describe, expect, test, vi } from 'vitest'
import { createFin, createVault, listVaults } from '@fin-kit/core'
import { openTursoFixture } from './fixture.js'
import { hostedTurso, openHostedTursoFixture } from './hosted-fixture.js'

describe(
  hostedTurso ? 'Turso hosted new engine conformance' : 'Turso SQL-peer supplemental conformance',
  () => {
    const disposers: (() => Promise<void>)[] = []
    afterEach(async () => {
      for (const dispose of disposers.splice(0)) await dispose()
    })
    async function fixture() {
      const f = hostedTurso ? await openHostedTursoFixture() : openTursoFixture()
      disposers.push(f.dispose)
      const { vault } = await createVault({ storage: f.storage, name: 'Conformance' })
      return {
        ...f,
        vault,
        fin: createFin({ storage: f.storage, vaultId: vault.id }),
        other: createFin({ storage: f.client(), vaultId: vault.id }),
      }
    }

    test('empty opt-out, concurrent preparation and one failed migration leave a compatible namespace', async () => {
      const f = hostedTurso ? await openHostedTursoFixture() : openTursoFixture()
      disposers.push(f.dispose)
      await expect(f.client({ autoMigrate: false }).read({ kind: 'vaults' })).rejects.toMatchObject(
        { code: 'SCHEMA_INCOMPATIBLE' },
      )
      const failing = f.client({
        fetch: async (input, init) => {
          const body = JSON.parse(String(init?.body))
          for (const r of body.requests.flatMap(
            (request: { batch?: { steps: unknown[] } }) => request.batch?.steps ?? [],
          ))
            if (r.stmt?.sql.startsWith('INSERT INTO fin_migrations'))
              r.stmt.args[0] = { type: 'null' }
          return f.fetch(input, { ...init, body: JSON.stringify(body) })
        },
      })
      await expect(failing.migrate()).rejects.toMatchObject({
        code: 'STORAGE_FAILURE',
        application: 'not_applied',
      })
      const empty = await f.probe.transaction((tx) =>
        tx.execute("SELECT name FROM sqlite_schema WHERE substr(name,1,length('fin_'))='fin_'"),
      )
      expect(empty.rows).toEqual([])
      let begins = 0
      const instrumented = {
        fetch: async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          if (
            JSON.parse(String(init?.body))
              .requests.flatMap((r: { batch?: { steps: unknown[] } }) => r.batch?.steps ?? [])
              .some((r: { stmt?: { sql?: string } }) => r.stmt?.sql === 'BEGIN IMMEDIATE')
          )
            begins++
          return f.fetch(input, init)
        },
      }
      const outcomes = await Promise.allSettled([
        f.client(instrumented).migrate(),
        f.client(instrumented).migrate(),
      ])
      expect(outcomes.some((r) => r.status === 'fulfilled')).toBe(true)
      for (const r of outcomes)
        if (r.status === 'rejected')
          expect(r.reason).toMatchObject({ code: 'STORAGE_FAILURE', application: 'not_applied' })
      expect(begins).toBe(2)
      expect(await listVaults({ storage: f.client({ autoMigrate: false }) })).toEqual([])
    }, 60000)

    test('held multi-table snapshot prevents independent writes until release; close drains admitted work', async () => {
      const f = await fixture()
      const a = (await f.fin.createAccount({ name: 'Cash', nature: 'asset', currency: 'KRW' }))
        .account
      let enter = () => {}
      let release = () => {}
      const entered = new Promise<void>((resolve) => {
        enter = resolve
      })
      const resumed = new Promise<void>((resolve) => {
        release = resolve
      })
      const storage = f.client({
        fetch: async (input, init) => {
          const response = await f.fetch(input, init)
          if (String(init?.body).includes('FROM fin_accounts')) {
            enter()
            await resumed
          }
          return response
        },
      })
      const work = storage.read({ kind: 'accounts', vaultId: f.vault.id, includeArchived: true })
      await entered
      let acknowledged = false
      const contender = f.other
        .recordIncomeExpense({ kind: 'income', accountId: a.id, amountMinor: 100 })
        .then(
          (result) => {
            acknowledged = true
            return result
          },
          (error) => {
            expect(error).toMatchObject({ code: 'STORAGE_FAILURE', application: 'not_applied' })
            return null
          },
        )
      try {
        await new Promise((resolve) => setTimeout(resolve, 250))
        expect(acknowledged).toBe(false)
        const close = storage.close()
        expect(storage.close()).toBe(close)
        await expect(storage.read({ kind: 'vaults' })).rejects.toMatchObject({
          code: 'STORAGE_FAILURE',
        })
        release()
        const snapshot = await work
        expect(snapshot.accounts.find((account) => account.id === a.id)?.balanceMinor).toBe(0)
        expect(snapshot.transactions).toEqual([])
        await close
        await contender
      } finally {
        release()
        await Promise.allSettled([work, contender])
      }
    }, 60000)

    test('async/nested decisions and unchanged results leave state/history untouched', async () => {
      const f = await fixture()
      const before = await f.fin.listChangeRecords()
      const decision = vi.fn(() => ({ kind: 'unchanged', result: 7 }) as const)
      expect(await f.storage.mutate({ kind: 'vault', vaultId: f.vault.id }, decision)).toBe(7)
      expect(decision).toHaveBeenCalledTimes(1)
      await expect(
        f.storage.mutate(
          { kind: 'vault', vaultId: f.vault.id },
          // @ts-expect-error Runtime callers can supply an asynchronous callback.
          async () => ({ kind: 'unchanged', result: 0 }),
        ),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
      let nested: Promise<unknown> | undefined
      await expect(
        f.storage.mutate({ kind: 'vault', vaultId: f.vault.id }, () => {
          nested = f.storage.read({ kind: 'vaults' })
          return { kind: 'unchanged', result: 0 }
        }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
      await expect(nested).rejects.toMatchObject({ code: 'INVALID_INPUT' })
      expect(await f.fin.listChangeRecords()).toEqual(before)
    }, 60000)

    test.each(['name', 'duplicate', 'aggregate', 'category', 'settings'])(
      'independent clients protect %s predicates and dependencies through commit',
      async (race) => {
        const f = await fixture()
        const a = (await f.fin.createAccount({ name: 'Cash', nature: 'asset', currency: 'KRW' }))
          .account
        const s = await f.fin.getSettings()
        let operations: (() => Promise<unknown>)[]
        if (race === 'name')
          operations = [f.fin, f.other].map(
            (fin) => () => fin.createAccount({ name: 'Raced', nature: 'asset', currency: 'KRW' }),
          )
        else if (race === 'duplicate')
          operations = [f.fin, f.other].map(
            (fin) => () =>
              fin.recordIncomeExpense({
                kind: 'income',
                accountId: a.id,
                amountMinor: 1,
                occurredOn: '2026-11-08',
                memo: 'same',
              }),
          )
        else if (race === 'aggregate') {
          await f.fin.recordIncomeExpense({
            kind: 'income',
            accountId: a.id,
            amountMinor: Number.MAX_SAFE_INTEGER - 1,
          })
          operations = [f.fin, f.other].map(
            (fin, i) => () =>
              fin.recordIncomeExpense({
                kind: 'income',
                accountId: a.id,
                amountMinor: 1,
                memo: `distinct-${i}`,
              }),
          )
        } else if (race === 'category') {
          const parent = (await f.fin.createCategory({ name: 'Parent' })).category
          const child = (await f.fin.createCategory({ name: 'Child', parentId: parent.id }))
            .category
          const destination = (await f.fin.createCategory({ name: 'Destination' })).category
          operations = [
            () =>
              f.fin.updateCategory({
                id: parent.id,
                expectedRevision: parent.revision,
                patch: { parentId: destination.id },
              }),
            () => f.other.createCategory({ name: 'Leaf', parentId: child.id }),
          ]
        } else
          operations = [
            () =>
              f.fin.setDefaultAccount({
                kind: 'income',
                accountId: a.id,
                expectedRevision: s.revision,
              }),
            () =>
              f.other.updateAccount({
                id: a.id,
                expectedRevision: a.revision,
                patch: { archived: true },
              }),
          ]
        const outcomes = await Promise.allSettled(operations.map((run) => run()))
        expect(outcomes.some((r) => r.status === 'fulfilled')).toBe(true)
        for (const r of outcomes)
          if (r.status === 'rejected')
            expect(r.reason).toMatchObject({
              application: 'not_applied',
              code: expect.stringMatching(
                /^(STORAGE_FAILURE|INVALID_INPUT|DUPLICATE_CANDIDATE|CONFLICT)$/,
              ),
            })
        if (race === 'name')
          expect((await f.fin.listAccounts()).filter((a) => a.name === 'Raced')).toHaveLength(1)
        if (race === 'duplicate') expect(await f.fin.listTransactions()).toHaveLength(1)
        if (race === 'aggregate')
          expect((await f.fin.getAccount({ id: a.id })).balanceMinor).toBe(Number.MAX_SAFE_INTEGER)
        if (race === 'category')
          expect((await f.fin.listCategories()).every((c) => c.path.split(' / ').length <= 3)).toBe(
            true,
          )
        if (race === 'settings') {
          const current = await f.fin.getSettings()
          const account = await f.fin.getAccount({ id: a.id })
          expect(!account.archived || current.incomeAccountId === null).toBe(true)
        }
      },
      60000,
    )

    test('independent stale edits have one acknowledged winner and coherent balance/history', async () => {
      const f = await fixture()
      const a = (await f.fin.createAccount({ name: 'Cash', nature: 'asset', currency: 'KRW' }))
        .account
      const t = (
        await f.fin.recordIncomeExpense({ kind: 'income', accountId: a.id, amountMinor: 100 })
      ).transaction
      const outcomes = await Promise.allSettled(
        [f.fin, f.other].map((fin, i) =>
          fin.editTransaction({
            id: t.id,
            expectedRevision: t.revision,
            patch: { memo: String(i) },
          }),
        ),
      )
      expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      expect((await f.fin.getAccount({ id: a.id })).balanceMinor).toBe(100)
      expect(await f.fin.listChangeRecords({ targetId: t.id })).toHaveLength(2)
    }, 60000)

    test('one synchronous decision and one real COMMIT with lost acknowledgement; independent exact history', async () => {
      const f = await fixture()
      let commits = 0
      const storage = f.client({
        fetch: async (input, init) => {
          const response = await f.fetch(input, init)
          if (
            JSON.parse(String(init?.body))
              .requests.flatMap((r: { batch?: { steps: unknown[] } }) => r.batch?.steps ?? [])
              .some((r: { stmt?: { sql?: string } }) => r.stmt?.sql === 'COMMIT')
          ) {
            const body = await response.clone().json()
            expect(response.status).toBe(200)
            expect(body.results[0].type).toBe('ok')
            expect(body.results[0].response.type).toBe('batch')
            expect(body.results[1].response.is_autocommit).toBe(true)
            commits++
            throw new Error('Injected real commit acknowledgement loss')
          }
          return response
        },
      })
      const record = {
        id: crypto.randomUUID(),
        vaultId: f.vault.id,
        target: 'vault',
        targetId: f.vault.id,
        action: 'updated',
        recordedAt: new Date().toISOString(),
        before: f.vault,
        after: { ...f.vault, name: '한글\u0000🙂', revision: 'supplied-revision' },
        balances: [],
      } satisfies import('@fin-kit/core').ChangeRecord
      const decide = vi.fn(
        () =>
          ({
            kind: 'changed',
            changes: { vault: record.after },
            record,
            result: record.after,
          }) as const,
      )
      await expect(
        storage.mutate({ kind: 'vault', vaultId: f.vault.id }, decide),
      ).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN', application: 'unknown' })
      expect(commits).toBe(1)
      expect(decide).toHaveBeenCalledTimes(1)
      expect(await f.other.getVault()).toEqual(record.after)
      expect(await f.other.listChangeRecords()).toContainEqual(record)
    }, 60000)

    test('a late actual history constraint failure rolls back prior state/revisions', async () => {
      const f = await fixture()
      const a = (await f.fin.createAccount({ name: 'Cash', nature: 'asset', currency: 'KRW' }))
        .account
      const t = (
        await f.fin.recordIncomeExpense({ kind: 'income', accountId: a.id, amountMinor: 100 })
      ).transaction
      const records = await f.fin.listChangeRecords()
      const account = await f.fin.getAccount({ id: a.id })
      const storage = f.client({
        fetch: async (input, init) => {
          const body = JSON.parse(String(init?.body))
          for (const r of body.requests.flatMap(
            (request: { batch?: { steps: unknown[] } }) => request.batch?.steps ?? [],
          ))
            if (r.stmt?.sql.startsWith('INSERT INTO fin_change_records'))
              r.stmt.args[1] = { type: 'text', value: records[0]?.id }
          return f.fetch(input, { ...init, body: JSON.stringify(body) })
        },
      })
      const fin = createFin({ storage, vaultId: f.vault.id })
      await expect(
        fin.editTransaction({
          id: t.id,
          expectedRevision: t.revision,
          patch: { amountMinor: 500 },
        }),
      ).rejects.toMatchObject({ code: 'STORAGE_FAILURE', application: 'not_applied' })
      expect(await f.other.getTransaction({ id: t.id })).toEqual(t)
      expect(await f.other.getAccount({ id: a.id })).toEqual(account)
      expect(await f.other.listChangeRecords()).toEqual(records)
    }, 60000)

    test('independent preparation/check-only and schema rejection preserve existing data', async () => {
      const f = await fixture()
      const client = f.client({ autoMigrate: false })
      await client.migrate()
      expect(await listVaults({ storage: client })).toEqual([f.vault])
      const before = await f.fin.listChangeRecords()
      await f.probe.transaction((tx) =>
        tx.execute("UPDATE fin_migrations SET identity='incompatible-test'"),
      )
      await expect(client.read({ kind: 'vaults' })).rejects.toMatchObject({
        code: 'SCHEMA_INCOMPATIBLE',
      })
      const persisted = await f.probe.transaction((tx) =>
        tx.execute('SELECT payload FROM fin_change_records WHERE vaultId=? ORDER BY rowid', [
          f.vault.id,
        ]),
      )
      expect(
        persisted.rows.map((r) => (typeof r[0] === 'string' ? JSON.parse(r[0]) : null)),
      ).toEqual(before)
    }, 60000)
  },
)
