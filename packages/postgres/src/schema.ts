import { DatabaseError, type PoolClient } from 'pg'
import { FinError } from '@fin/provider'

const initialMigration = `
-- fin text encoding: backslash-v1 (NUL and lone UTF-16 surrogates).
CREATE TABLE fin_vaults (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, revision TEXT NOT NULL, archived BOOLEAN NOT NULL, generation TEXT NOT NULL, stamp BIGINT NOT NULL);
CREATE TABLE fin_change_records (sequence BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,"vaultId" TEXT NOT NULL REFERENCES fin_vaults(id), id TEXT NOT NULL, "targetId" TEXT NOT NULL, payload JSONB NOT NULL, PRIMARY KEY("vaultId",id));
CREATE INDEX fin_history_target ON fin_change_records("vaultId","targetId");
CREATE TABLE fin_accounts ("vaultId" TEXT NOT NULL REFERENCES fin_vaults(id), id TEXT NOT NULL, name TEXT NOT NULL, revision TEXT NOT NULL, "balanceRevision" TEXT NOT NULL, nature TEXT NOT NULL CHECK(nature IN ('asset','liability')), currency TEXT NOT NULL CHECK(length(currency)=3), archived BOOLEAN NOT NULL, "hasTransactions" BOOLEAN NOT NULL, PRIMARY KEY("vaultId",id), UNIQUE("vaultId",name));
CREATE TABLE fin_settings ("vaultId" TEXT PRIMARY KEY NOT NULL REFERENCES fin_vaults(id), revision TEXT NOT NULL, "incomeAccountId" TEXT, "expenseAccountId" TEXT, FOREIGN KEY("vaultId","incomeAccountId") REFERENCES fin_accounts("vaultId",id), FOREIGN KEY("vaultId","expenseAccountId") REFERENCES fin_accounts("vaultId",id));
CREATE TABLE fin_categories ("vaultId" TEXT NOT NULL REFERENCES fin_vaults(id), id TEXT NOT NULL, revision TEXT NOT NULL, name TEXT NOT NULL, "parentId" TEXT, archived BOOLEAN NOT NULL, PRIMARY KEY("vaultId",id), FOREIGN KEY("vaultId","parentId") REFERENCES fin_categories("vaultId",id));
CREATE UNIQUE INDEX fin_category_siblings ON fin_categories("vaultId",coalesce("parentId",''),name);
CREATE TABLE fin_transactions ("vaultId" TEXT NOT NULL REFERENCES fin_vaults(id), id TEXT NOT NULL, revision TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('income','expense','transfer','adjustment')), "occurredOn" TEXT NOT NULL, memo TEXT, "accountId" TEXT, "amountMinor" BIGINT, "sourceAccountId" TEXT, "sourceAmountMinor" BIGINT, "destinationAccountId" TEXT, "destinationAmountMinor" BIGINT, PRIMARY KEY("vaultId",id), FOREIGN KEY("vaultId","accountId") REFERENCES fin_accounts("vaultId",id), FOREIGN KEY("vaultId","sourceAccountId") REFERENCES fin_accounts("vaultId",id), FOREIGN KEY("vaultId","destinationAccountId") REFERENCES fin_accounts("vaultId",id), CHECK((kind='transfer' AND "accountId" IS NULL AND "amountMinor" IS NULL AND "sourceAccountId" IS NOT NULL AND "destinationAccountId" IS NOT NULL AND "sourceAccountId"<>"destinationAccountId" AND "sourceAmountMinor" IS NOT NULL AND "destinationAmountMinor" IS NOT NULL AND "sourceAmountMinor">0 AND "destinationAmountMinor">0) OR (kind<>'transfer' AND "accountId" IS NOT NULL AND "amountMinor" IS NOT NULL AND "sourceAccountId" IS NULL AND "sourceAmountMinor" IS NULL AND "destinationAccountId" IS NULL AND "destinationAmountMinor" IS NULL)), CHECK("amountMinor" IS NULL OR ("amountMinor" BETWEEN -9007199254740991 AND 9007199254740991)), CHECK("sourceAmountMinor" IS NULL OR ("sourceAmountMinor" BETWEEN 1 AND 9007199254740991)), CHECK("destinationAmountMinor" IS NULL OR ("destinationAmountMinor" BETWEEN 1 AND 9007199254740991)), CHECK(kind='transfer' OR (kind='income' AND "amountMinor">0) OR (kind IN ('expense','adjustment') AND "amountMinor"<>0)));
CREATE INDEX fin_transaction_account ON fin_transactions("vaultId","accountId");
CREATE INDEX fin_transaction_source ON fin_transactions("vaultId","sourceAccountId");
CREATE INDEX fin_transaction_destination ON fin_transactions("vaultId","destinationAccountId");
CREATE INDEX fin_transaction_date ON fin_transactions("vaultId","occurredOn");
CREATE TABLE fin_category_assignments (position INTEGER NOT NULL CHECK(position>=0),"vaultId" TEXT NOT NULL, "transactionId" TEXT NOT NULL, "categoryId" TEXT NOT NULL, "amountMinor" BIGINT NOT NULL CHECK("amountMinor"<>0 AND "amountMinor" BETWEEN -9007199254740991 AND 9007199254740991), origin TEXT NOT NULL CHECK(origin IN ('explicit','inferred')), PRIMARY KEY("vaultId","transactionId","categoryId"), FOREIGN KEY("vaultId","transactionId") REFERENCES fin_transactions("vaultId",id) ON DELETE CASCADE, FOREIGN KEY("vaultId","categoryId") REFERENCES fin_categories("vaultId",id));
CREATE TABLE fin_transaction_relations (position INTEGER NOT NULL CHECK(position>=0),"vaultId" TEXT NOT NULL, "sourceId" TEXT NOT NULL, "targetTransactionId" TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('refund_of','fee_for')), PRIMARY KEY("vaultId","sourceId","targetTransactionId",kind), FOREIGN KEY("vaultId","sourceId") REFERENCES fin_transactions("vaultId",id) ON DELETE CASCADE, FOREIGN KEY("vaultId","targetTransactionId") REFERENCES fin_transactions("vaultId",id) ON DELETE CASCADE, CHECK("sourceId"<>"targetTransactionId"));
CREATE INDEX fin_relation_target ON fin_transaction_relations("vaultId","targetTransactionId");
CREATE VIEW fin_category_paths AS WITH RECURSIVE paths("vaultId",id,revision,name,"parentId",archived,path,depth) AS (SELECT "vaultId",id,revision,name,"parentId",archived,name,1 FROM fin_categories WHERE "parentId" IS NULL UNION ALL SELECT c."vaultId",c.id,c.revision,c.name,c."parentId",c.archived,p.path || ' / ' || c.name,p.depth+1 FROM fin_categories c JOIN paths p ON c."vaultId"=p."vaultId" AND c."parentId"=p.id WHERE p.depth<3) SELECT "vaultId",id,revision,name,"parentId",archived,path FROM paths;
CREATE TABLE fin_migrations (version INTEGER PRIMARY KEY, identity TEXT NOT NULL, structure JSONB NOT NULL);
`

// Compare catalog semantics, not just a claimed version. Sequence counters and
// physical OIDs are deliberately excluded; columns, constraints, indexes and views are not.
const structureQuery = `
SELECT jsonb_agg(shape ORDER BY name) AS structure FROM (
  SELECT c.relname AS name, jsonb_build_object(
    'name', c.relname, 'kind', c.relkind,
    'columns', (SELECT jsonb_agg(jsonb_build_array(a.attname, format_type(a.atttypid,a.atttypmod),a.attnotnull,a.attidentity,pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum)
      FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
    'constraints', (SELECT jsonb_agg(pg_get_constraintdef(k.oid) ORDER BY k.conname) FROM pg_constraint k WHERE k.conrelid=c.oid),
    'index', CASE WHEN c.relkind='i' THEN pg_get_indexdef(c.oid) END,
    'view', CASE WHEN c.relkind='v' THEN pg_get_viewdef(c.oid) END
  ) AS shape FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND left(c.relname,4)='fin_' AND c.relkind IN ('r','v','i','S','m','p','f')
) catalog`

/** Transactional, serialized bootstrap plus exact compatibility checks, preserving host data. */
export async function prepareSchema(client: PoolClient, allowCreate: boolean): Promise<void> {
  await client.query('BEGIN')
  try {
    await client.query('SET LOCAL search_path = public, pg_catalog')
    // A transaction-scoped, database-local preparation lock; released BEFORE financial work.
    await client.query('SELECT pg_advisory_xact_lock(1718185521, 1)')
    const { rows: catalog } = await client.query<{ structure: unknown }>(structureQuery)
    if (catalog[0]?.structure == null && allowCreate) {
      await client.query(initialMigration)
      const { rows } = await client.query<{ structure: unknown }>(structureQuery)
      await client.query(
        'INSERT INTO fin_migrations(version,identity,structure) VALUES (1,$1,$2)',
        [initialMigration, JSON.stringify(rows[0]?.structure)],
      )
    } else {
      let matches = false
      try {
        const { rows } = await client.query<{
          version: number
          identity: string
          structure: unknown
        }>('SELECT version,identity,structure FROM fin_migrations')
        matches =
          rows.length === 1 &&
          rows[0]?.version === 1 &&
          rows[0].identity === initialMigration &&
          JSON.stringify(rows[0].structure) === JSON.stringify(catalog[0]?.structure)
      } catch (error) {
        // Missing tables/columns are incompatible; transport and authorization
        // failures must retain their storage classification.
        if (
          !(error instanceof DatabaseError) ||
          !['42P01', '42703', '42804'].includes(error.code ?? '')
        )
          throw error
      }
      if (!matches)
        throw new FinError(
          'SCHEMA_INCOMPATIBLE',
          'The PostgreSQL fin schema is missing or incompatible.',
          'Prepare an empty fin namespace explicitly, or use a compatible database. Existing data was not overwritten.',
        )
    }
    const ack = await client.query('COMMIT')
    if (ack.command !== 'COMMIT') throw new Error('Schema commit was not acknowledged')
  } catch (error) {
    try {
      await client.query('ROLLBACK')
    } catch {
      /* Preserve the preparation failure. */
    }
    throw error
  }
}
