import type { PoolClient } from 'pg'
import {
  FinError,
  type DomainContext,
  type ReadRequest,
  type MutationRequest,
  type DomainChanges,
  type ChangeRecord,
  type Vault,
  type VaultSettings,
  type Account,
  type Category,
  type Transaction,
} from '@fin-kit/provider'

// PostgreSQL text/jsonb cannot represent NUL or lone UTF-16 surrogates. Escaping
// the marker as well makes this injective; valid Unicode (including pairs) is unchanged.
export function encodeText(value: string): string {
  // oxlint-disable-next-line no-control-regex -- NUL must be encoded before PostgreSQL parsing.
  return value.replace(/[\\\u0000\uD800-\uDFFF]/gu, (char) =>
    char === '\\' ? '\\\\' : char === '\u0000' ? '\\0' : `\\u${char.charCodeAt(0).toString(16)}`,
  )
}

// Only call on freshly loaded SQL rows/JSON, before exposing or comparing them.
// Mutating string leaves preserves the typed row shape without asserting a generic cast.
function decodeStoredStrings(value: object | null): void {
  if (value === null) return
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === 'string') {
      const pattern = /\\(\\|0|u[dD][89a-fA-F][0-9a-fA-F]{2})/g
      if (child.replace(pattern, '').includes('\\'))
        throw new FinError(
          'STORAGE_FAILURE',
          'Stored PostgreSQL text has an invalid encoding.',
          'Inspect the schema and stored data before retrying.',
        )
      Reflect.set(
        value,
        key,
        child.replace(pattern, (_, escaped: string) =>
          escaped === '\\'
            ? '\\'
            : escaped === '0'
              ? '\u0000'
              : String.fromCharCode(Number.parseInt(escaped.slice(1), 16)),
        ),
      )
    } else if (typeof child === 'object') decodeStoredStrings(child)
  }
}

/** Project SQL rows, derived balances/paths and history from the caller's single transaction. */
export async function readContext(
  client: PoolClient,
  request: ReadRequest | MutationRequest,
): Promise<DomainContext> {
  const context: DomainContext = {
    vault: null,
    vaults: [],
    settings: null,
    accounts: [],
    categories: [],
    transactions: [],
    records: [],
  }
  if (request.kind === 'createVault') return context
  if (request.kind === 'vaults') {
    context.vaults = (
      await client.query<Vault>(
        'SELECT id,name,revision,archived FROM fin_vaults WHERE $1 OR NOT archived ORDER BY id',
        [request.includeArchived ?? false],
      )
    ).rows
    decodeStoredStrings(context.vaults)
    return context
  }
  const params = [encodeText(request.vaultId)]
  context.vault =
    (
      await client.query<Vault>(
        'SELECT id,name,revision,archived FROM fin_vaults WHERE id=$1',
        params,
      )
    ).rows[0] ?? null
  decodeStoredStrings(context.vault)
  if (!context.vault)
    throw new FinError(
      'NOT_FOUND',
      'Vault does not exist.',
      'List Vaults or create a new Vault.',
      'not_applied',
      { vaultId: request.vaultId },
    )
  context.settings =
    (
      await client.query<VaultSettings>(
        'SELECT revision,"incomeAccountId","expenseAccountId" FROM fin_settings WHERE "vaultId"=$1',
        params,
      )
    ).rows[0] ?? null
  decodeStoredStrings(context.settings)
  if (request.kind === 'vault' || request.kind === 'history') {
    if (request.kind === 'history')
      context.records = (
        await client.query<{ payload: ChangeRecord }>(
          'SELECT payload FROM fin_change_records WHERE "vaultId"=$1 AND ($2::text IS NULL OR id=$2) AND ($3::text IS NULL OR "targetId"=$3) ORDER BY sequence LIMIT $4 OFFSET $5',
          [
            encodeText(request.vaultId),
            request.id === undefined ? null : encodeText(request.id),
            request.targetId === undefined ? null : encodeText(request.targetId),
            request.limit ?? 100,
            request.offset ?? 0,
          ],
        )
      ).rows.map((row) => row.payload)
    decodeStoredStrings(context.records)
    return context
  }
  // Full Vault dependencies keep absence/predicate/aggregate decisions inside the
  // root-lock boundary. This initial implementation favors correctness over large-ledger scans.
  const accounts = (
    await client.query<Omit<Account, 'balanceMinor'> & { balance: string }>(
      `
    SELECT a.id,a.name,a.revision,a."balanceRevision",a.nature,a.currency,a.archived,a."hasTransactions",
      (coalesce((SELECT sum(CASE WHEN t.kind='income' THEN t."amountMinor" WHEN t.kind='expense' THEN -t."amountMinor"
        WHEN t.kind='adjustment' THEN CASE WHEN a.nature='asset' THEN t."amountMinor" ELSE -t."amountMinor" END
        WHEN t."sourceAccountId"=a.id THEN -t."sourceAmountMinor" ELSE t."destinationAmountMinor" END)
        FROM fin_transactions t WHERE t."vaultId"=a."vaultId" AND (t."accountId"=a.id OR t."sourceAccountId"=a.id OR t."destinationAccountId"=a.id)),0)
        * CASE WHEN a.nature='asset' THEN 1 ELSE -1 END)::text AS balance
    FROM fin_accounts a WHERE a."vaultId"=$1 ORDER BY a.id`,
      params,
    )
  ).rows
  context.accounts = accounts.map(({ balance, ...account }) => {
    const exact = BigInt(balance)
    if (exact > BigInt(Number.MAX_SAFE_INTEGER) || exact < BigInt(Number.MIN_SAFE_INTEGER))
      throw new FinError(
        'STORAGE_FAILURE',
        'An account balance exceeds safe integer minor units.',
        'Inspect stored financial amounts.',
      )
    return { ...account, balanceMinor: Number(exact) }
  })
  decodeStoredStrings(context.accounts)
  if (request.kind === 'accounts') {
    context.accounts = context.accounts.filter(
      (a) => (!request.id || a.id === request.id) && (request.includeArchived || !a.archived),
    )
    return context
  }
  if (request.kind === 'account') {
    context.accounts = context.accounts.filter(
      (a) => a.id === request.id || a.name === request.name,
    )
    return context
  }
  if (request.kind === 'settings') {
    const ids = 'accountIds' in request ? (request.accountIds ?? []) : []
    context.accounts = context.accounts.filter((a) => ids.includes(a.id))
    return context
  }
  context.categories = (
    await client.query<Category>(
      'SELECT id,revision,name,"parentId",archived,path FROM fin_category_paths WHERE "vaultId"=$1 ORDER BY id',
      params,
    )
  ).rows
  decodeStoredStrings(context.categories)
  if (request.kind === 'categories') {
    context.categories = context.categories.filter(
      (c) => (!request.id || c.id === request.id) && (request.includeArchived || !c.archived),
    )
    return context
  }
  if (request.kind === 'category') return context
  context.transactions = (
    await client.query<{ data: Transaction }>(
      `
    SELECT (jsonb_build_object('id',t.id,'revision',t.revision,'kind',t.kind,'occurredOn',t."occurredOn",'memo',t.memo,
      'assignments',coalesce((SELECT jsonb_agg(jsonb_build_object('categoryId',a."categoryId",'amountMinor',a."amountMinor",'origin',a.origin) ORDER BY a.position)
        FROM fin_category_assignments a WHERE a."vaultId"=t."vaultId" AND a."transactionId"=t.id),'[]'::jsonb),
      'relations',coalesce((SELECT jsonb_agg(jsonb_build_object('kind',r.kind,'targetTransactionId',r."targetTransactionId") ORDER BY r.position)
        FROM fin_transaction_relations r WHERE r."vaultId"=t."vaultId" AND r."sourceId"=t.id),'[]'::jsonb)) ||
      CASE WHEN t.kind='transfer' THEN jsonb_build_object('sourceAccountId',t."sourceAccountId",'sourceAmountMinor',t."sourceAmountMinor",'destinationAccountId',t."destinationAccountId",'destinationAmountMinor',t."destinationAmountMinor")
      ELSE jsonb_build_object('accountId',t."accountId",'amountMinor',t."amountMinor") END) AS data
    FROM fin_transactions t WHERE t."vaultId"=$1 ORDER BY t."occurredOn",t.id`,
      params,
    )
  ).rows.map(({ data }) => ({
    ...data,
    // Core compares these ordered objects for no-op detection. JSONB canonicalizes
    // object keys; restore the public assignment/relation field order on decoding.
    assignments: data.assignments.map((a) => ({
      categoryId: a.categoryId,
      amountMinor: a.amountMinor,
      origin: a.origin,
    })),
    relations: data.relations.map((r) => ({
      kind: r.kind,
      targetTransactionId: r.targetTransactionId,
    })),
  }))
  decodeStoredStrings(context.transactions)
  if (request.kind === 'transaction') {
    if (request.recordId)
      context.records = (
        await client.query<{ payload: ChangeRecord }>(
          'SELECT payload FROM fin_change_records WHERE "vaultId"=$1 AND id=$2',
          [encodeText(request.vaultId), encodeText(request.recordId)],
        )
      ).rows.map((row) => row.payload)
    decodeStoredStrings(context.records)
    return context
  }
  const filters = request.kind === 'transactions' ? request.filters : undefined
  const selected = context.categories.find((c) => c.id === filters?.categoryId)
  if (filters?.categoryId && !selected)
    throw new FinError(
      'NOT_FOUND',
      'Category does not exist in this Vault.',
      'Use a category in this Vault.',
    )
  context.transactions = context.transactions
    .filter((t) => {
      if (filters?.id && t.id !== filters.id) return false
      if (filters?.kinds && !filters.kinds.includes(t.kind)) return false
      if (filters?.dateFrom && t.occurredOn < filters.dateFrom) return false
      if (filters?.dateTo && t.occurredOn > filters.dateTo) return false
      if (
        filters?.accountId &&
        !(
          t.kind === 'transfer' ? [t.sourceAccountId, t.destinationAccountId] : [t.accountId]
        ).includes(filters.accountId)
      )
        return false
      const categories = context.categories.filter((c) =>
        t.assignments.some((a) => a.categoryId === c.id),
      )
      if (
        selected &&
        !categories.some((c) => c.id === selected.id || c.path.startsWith(`${selected.path} / `))
      )
        return false
      const text = filters?.search?.toLocaleLowerCase()
      return (
        !text ||
        [t.memo ?? '', ...categories.map((c) => c.path)].some((value) =>
          value.toLocaleLowerCase().includes(text),
        )
      )
    })
    .slice(
      filters?.offset ?? 0,
      filters?.limit === undefined ? undefined : (filters.offset ?? 0) + filters.limit,
    )
  return context
}

/** Persist the supplied plan in FK-safe order, preserving revisions and exact ordered snapshots. */
export async function writeChanges(
  client: PoolClient,
  request: MutationRequest,
  changes: DomainChanges,
  record: ChangeRecord,
): Promise<void> {
  const vaultId = request.kind === 'createVault' ? changes.vault?.id : request.vaultId
  if (!vaultId || record.vaultId !== vaultId || (changes.vault && changes.vault.id !== vaultId))
    throw new FinError(
      'INVALID_INPUT',
      'The change plan crosses Vault boundaries.',
      'Supply a plan for the requested Vault.',
    )
  JSON.stringify({ changes, record }, (_key, value: unknown) => {
    if (typeof value === 'number' && !Number.isSafeInteger(value))
      throw new FinError(
        'INVALID_INPUT',
        'Financial values must be safe integers.',
        'Supply integer minor units within the safe range.',
      )
    return value
  })
  if (changes.vault) {
    const v = changes.vault
    if (request.kind === 'createVault')
      await client.query(
        'INSERT INTO fin_vaults(id,name,revision,archived,generation,stamp) VALUES ($1,$2,$3,$4,$5,0)',
        [v.id, v.name, v.revision, v.archived, crypto.randomUUID()].map((value) =>
          typeof value === 'string' ? encodeText(value) : value,
        ),
      )
    else
      await client.query(
        'UPDATE fin_vaults SET name=$2,revision=$3,archived=$4 WHERE id=$1',
        [vaultId, v.name, v.revision, v.archived].map((value) =>
          typeof value === 'string' ? encodeText(value) : value,
        ),
      )
  }
  for (const a of changes.accounts ?? [])
    await client.query(
      `INSERT INTO fin_accounts("vaultId",id,name,revision,"balanceRevision",nature,currency,archived,"hasTransactions") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT ("vaultId",id) DO UPDATE SET name=EXCLUDED.name,revision=EXCLUDED.revision,"balanceRevision"=EXCLUDED."balanceRevision",nature=EXCLUDED.nature,currency=EXCLUDED.currency,archived=EXCLUDED.archived,"hasTransactions"=EXCLUDED."hasTransactions"`,
      [
        vaultId,
        a.id,
        a.name,
        a.revision,
        a.balanceRevision,
        a.nature,
        a.currency,
        a.archived,
        a.hasTransactions,
      ].map((value) => (typeof value === 'string' ? encodeText(value) : value)),
    )
  if (changes.settings) {
    const s = changes.settings
    await client.query(
      'INSERT INTO fin_settings("vaultId",revision,"incomeAccountId","expenseAccountId") VALUES ($1,$2,$3,$4) ON CONFLICT ("vaultId") DO UPDATE SET revision=EXCLUDED.revision,"incomeAccountId"=EXCLUDED."incomeAccountId","expenseAccountId"=EXCLUDED."expenseAccountId"',
      [vaultId, s.revision, s.incomeAccountId, s.expenseAccountId].map((value) =>
        value === null ? null : encodeText(value),
      ),
    )
  }
  for (const c of changes.categories ?? [])
    await client.query(
      'INSERT INTO fin_categories("vaultId",id,revision,name,"parentId",archived) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT ("vaultId",id) DO UPDATE SET revision=EXCLUDED.revision,name=EXCLUDED.name,"parentId"=EXCLUDED."parentId",archived=EXCLUDED.archived',
      [vaultId, c.id, c.revision, c.name, c.parentId, c.archived].map((value) =>
        typeof value === 'string' ? encodeText(value) : value,
      ),
    )
  for (const t of changes.transactions ?? [])
    await client.query(
      `INSERT INTO fin_transactions("vaultId",id,revision,kind,"occurredOn",memo,"accountId","amountMinor","sourceAccountId","sourceAmountMinor","destinationAccountId","destinationAmountMinor") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    ON CONFLICT ("vaultId",id) DO UPDATE SET revision=EXCLUDED.revision,kind=EXCLUDED.kind,"occurredOn"=EXCLUDED."occurredOn",memo=EXCLUDED.memo,"accountId"=EXCLUDED."accountId","amountMinor"=EXCLUDED."amountMinor","sourceAccountId"=EXCLUDED."sourceAccountId","sourceAmountMinor"=EXCLUDED."sourceAmountMinor","destinationAccountId"=EXCLUDED."destinationAccountId","destinationAmountMinor"=EXCLUDED."destinationAmountMinor"`,
      [
        vaultId,
        t.id,
        t.revision,
        t.kind,
        t.occurredOn,
        t.memo,
        ...(t.kind === 'transfer'
          ? [
              null,
              null,
              t.sourceAccountId,
              t.sourceAmountMinor,
              t.destinationAccountId,
              t.destinationAmountMinor,
            ]
          : [t.accountId, t.amountMinor, null, null, null, null]),
      ].map((value) => (typeof value === 'string' ? encodeText(value) : value)),
    )
  for (const t of changes.transactions ?? []) {
    await client.query(
      'DELETE FROM fin_category_assignments WHERE "vaultId"=$1 AND "transactionId"=$2',
      [encodeText(vaultId), encodeText(t.id)],
    )
    await client.query(
      'DELETE FROM fin_transaction_relations WHERE "vaultId"=$1 AND "sourceId"=$2',
      [encodeText(vaultId), encodeText(t.id)],
    )
    for (const [position, a] of t.assignments.entries())
      await client.query(
        'INSERT INTO fin_category_assignments("vaultId","transactionId","categoryId","amountMinor",origin,position) VALUES ($1,$2,$3,$4,$5,$6)',
        [vaultId, t.id, a.categoryId, a.amountMinor, a.origin, position].map((value) =>
          typeof value === 'string' ? encodeText(value) : value,
        ),
      )
    for (const [position, r] of t.relations.entries())
      await client.query(
        'INSERT INTO fin_transaction_relations("vaultId","sourceId","targetTransactionId",kind,position) VALUES ($1,$2,$3,$4,$5)',
        [vaultId, t.id, r.targetTransactionId, r.kind, position].map((value) =>
          typeof value === 'string' ? encodeText(value) : value,
        ),
      )
  }
  if (changes.deleteTransactionId)
    await client.query('DELETE FROM fin_transactions WHERE "vaultId"=$1 AND id=$2', [
      encodeText(vaultId),
      encodeText(changes.deleteTransactionId),
    ])
  await client.query(
    'INSERT INTO fin_change_records("vaultId",id,"targetId",payload) VALUES ($1,$2,$3,$4)',
    [
      encodeText(vaultId),
      encodeText(record.id),
      encodeText(record.targetId),
      JSON.stringify(record, (_key, value: unknown) =>
        typeof value === 'string' ? encodeText(value) : value,
      ),
    ],
  )
  await client.query('UPDATE fin_vaults SET stamp=stamp+1 WHERE id=$1', [encodeText(vaultId)])
}
