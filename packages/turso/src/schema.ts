import { createHash } from 'node:crypto'
import { FinError } from '@fin-kit/provider'
import { isProjection, isWrite, type OperationSession } from './session.js'

// Adapter-specific identity: similar SQLite assets do not imply interoperability.
const statements = `
CREATE TABLE fin_migrations (version INTEGER PRIMARY KEY NOT NULL, identity TEXT NOT NULL);

CREATE TABLE fin_vaults (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, revision TEXT NOT NULL, archived INTEGER NOT NULL CHECK(archived IN (0,1)), generation TEXT NOT NULL, stamp INTEGER NOT NULL);
CREATE TABLE fin_settings (vaultId TEXT PRIMARY KEY NOT NULL REFERENCES fin_vaults(id), revision TEXT NOT NULL, incomeAccountId TEXT, expenseAccountId TEXT, FOREIGN KEY(vaultId,incomeAccountId) REFERENCES fin_accounts(vaultId,id), FOREIGN KEY(vaultId,expenseAccountId) REFERENCES fin_accounts(vaultId,id));
CREATE TABLE fin_change_records (vaultId TEXT NOT NULL REFERENCES fin_vaults(id), id TEXT NOT NULL, targetId TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)), PRIMARY KEY(vaultId,id));
CREATE INDEX fin_history_target ON fin_change_records(vaultId,targetId);
CREATE TABLE fin_accounts (vaultId TEXT NOT NULL REFERENCES fin_vaults(id), id TEXT NOT NULL, name TEXT NOT NULL, revision TEXT NOT NULL, balanceRevision TEXT NOT NULL, nature TEXT NOT NULL CHECK(nature IN ('asset','liability')), currency TEXT NOT NULL CHECK(length(currency)=3), archived INTEGER NOT NULL CHECK(archived IN (0,1)), hasTransactions INTEGER NOT NULL CHECK(hasTransactions IN (0,1)), PRIMARY KEY(vaultId,id), UNIQUE(vaultId,name));
CREATE TABLE fin_categories (vaultId TEXT NOT NULL REFERENCES fin_vaults(id), id TEXT NOT NULL, revision TEXT NOT NULL, name TEXT NOT NULL, parentId TEXT, archived INTEGER NOT NULL CHECK(archived IN (0,1)), PRIMARY KEY(vaultId,id), FOREIGN KEY(vaultId,parentId) REFERENCES fin_categories(vaultId,id));
CREATE UNIQUE INDEX fin_category_siblings ON fin_categories(vaultId,coalesce(parentId,''),name);
CREATE TABLE fin_transactions (vaultId TEXT NOT NULL REFERENCES fin_vaults(id), id TEXT NOT NULL, revision TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('income','expense','transfer','adjustment')), occurredOn TEXT NOT NULL, memo TEXT, accountId TEXT, amountMinor INTEGER, sourceAccountId TEXT, sourceAmountMinor INTEGER, destinationAccountId TEXT, destinationAmountMinor INTEGER, PRIMARY KEY(vaultId,id), FOREIGN KEY(vaultId,accountId) REFERENCES fin_accounts(vaultId,id), FOREIGN KEY(vaultId,sourceAccountId) REFERENCES fin_accounts(vaultId,id), FOREIGN KEY(vaultId,destinationAccountId) REFERENCES fin_accounts(vaultId,id), CHECK((kind='transfer' AND accountId IS NULL AND amountMinor IS NULL AND sourceAccountId IS NOT NULL AND destinationAccountId IS NOT NULL AND sourceAccountId<>destinationAccountId AND sourceAmountMinor IS NOT NULL AND destinationAmountMinor IS NOT NULL AND sourceAmountMinor>0 AND destinationAmountMinor>0) OR (kind<>'transfer' AND accountId IS NOT NULL AND amountMinor IS NOT NULL AND sourceAccountId IS NULL AND sourceAmountMinor IS NULL AND destinationAccountId IS NULL AND destinationAmountMinor IS NULL)), CHECK(amountMinor IS NULL OR (typeof(amountMinor)='integer' AND amountMinor BETWEEN -9007199254740991 AND 9007199254740991)), CHECK(sourceAmountMinor IS NULL OR (typeof(sourceAmountMinor)='integer' AND sourceAmountMinor BETWEEN 1 AND 9007199254740991)), CHECK(destinationAmountMinor IS NULL OR (typeof(destinationAmountMinor)='integer' AND destinationAmountMinor BETWEEN 1 AND 9007199254740991)), CHECK(kind='transfer' OR (kind='income' AND amountMinor>0) OR (kind IN ('expense','adjustment') AND amountMinor<>0)));
CREATE INDEX fin_transaction_account ON fin_transactions(vaultId,accountId);
CREATE INDEX fin_transaction_source ON fin_transactions(vaultId,sourceAccountId);
CREATE INDEX fin_transaction_destination ON fin_transactions(vaultId,destinationAccountId);
CREATE INDEX fin_transaction_date ON fin_transactions(vaultId,occurredOn);
CREATE TABLE fin_category_assignments (vaultId TEXT NOT NULL, transactionId TEXT NOT NULL, categoryId TEXT NOT NULL, amountMinor INTEGER NOT NULL CHECK(typeof(amountMinor)='integer' AND amountMinor<>0 AND amountMinor BETWEEN -9007199254740991 AND 9007199254740991), origin TEXT NOT NULL CHECK(origin IN ('explicit','inferred')), PRIMARY KEY(vaultId,transactionId,categoryId), FOREIGN KEY(vaultId,transactionId) REFERENCES fin_transactions(vaultId,id) ON DELETE CASCADE, FOREIGN KEY(vaultId,categoryId) REFERENCES fin_categories(vaultId,id));
CREATE TABLE fin_transaction_relations (vaultId TEXT NOT NULL, sourceId TEXT NOT NULL, targetTransactionId TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('refund_of','fee_for')), PRIMARY KEY(vaultId,sourceId,targetTransactionId,kind), FOREIGN KEY(vaultId,sourceId) REFERENCES fin_transactions(vaultId,id) ON DELETE CASCADE, FOREIGN KEY(vaultId,targetTransactionId) REFERENCES fin_transactions(vaultId,id) ON DELETE CASCADE, CHECK(sourceId<>targetTransactionId));
CREATE INDEX fin_relation_target ON fin_transaction_relations(vaultId,targetTransactionId);
CREATE VIEW fin_category_paths AS
SELECT c.vaultId,c.id,c.revision,c.name,c.parentId,c.archived,c.name AS path FROM fin_categories c WHERE c.parentId IS NULL
UNION ALL SELECT c.vaultId,c.id,c.revision,c.name,c.parentId,c.archived,p.name || ' / ' || c.name FROM fin_categories c JOIN fin_categories p ON c.vaultId=p.vaultId AND c.parentId=p.id WHERE p.parentId IS NULL
UNION ALL SELECT c.vaultId,c.id,c.revision,c.name,c.parentId,c.archived,g.name || ' / ' || p.name || ' / ' || c.name FROM fin_categories c JOIN fin_categories p ON c.vaultId=p.vaultId AND c.parentId=p.id JOIN fin_categories g ON p.vaultId=g.vaultId AND p.parentId=g.id WHERE g.parentId IS NULL;
`
  .split(';')
  .map((s) => s.trim())
  .filter(Boolean)
const identity =
  'fin-turso-v1:' + createHash('sha256').update(JSON.stringify(statements)).digest('hex')
// Turso reprints catalog DDL (for example CHECK (...) and comma spacing).
// Compare lexical tokens rather than bytes: whitespace between tokens is cosmetic,
// but literal contents, names, operators, comments and token boundaries are not.
// This is deliberately an identity check for our bundled DDL, not a SQL parser or
// a general claim that differently spelled SQL has the same semantics.
function schemaTokens(sql: string): string {
  return JSON.stringify(
    sql.match(
      /'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|--[^\r\n]*|\/\*[\s\S]*?\*\/|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[A-Za-z_][A-Za-z_0-9]*|->>|->|\|\||<>|<=|>=|!=|==|[^\s]/g,
    ) ?? [],
  )
}

const assets = statements.map((sql) => {
  const match = /^CREATE (?:UNIQUE )?(TABLE|INDEX|VIEW) (fin_\w+)/.exec(sql)
  if (!match?.[1] || !match[2]) throw new Error('Invalid bundled Turso migration')
  return { name: match[2], type: match[1].toLowerCase(), tokens: schemaTokens(sql) }
})

// Run inside the operation's IMMEDIATE transaction. Inspect identity AND actual
// assets on every operation; no stale ready flag can hide an external schema edit.
export async function prepareSchema(tx: OperationSession, allowCreate: boolean): Promise<void> {
  const incompatible = new FinError(
    'SCHEMA_INCOMPATIBLE',
    'The Turso fin namespace is absent or incompatible with this adapter.',
    'Use migrate() for an empty namespace or open a compatible database; existing data is never repaired automatically.',
  )
  const objects = await tx.execute(
    "SELECT name,type,sql FROM sqlite_schema WHERE (substr(name,1,length('fin_'))='fin_' OR substr(tbl_name,1,length('fin_'))='fin_') AND sql IS NOT NULL ORDER BY name",
  )
  if (!isProjection(objects, ['name', 'type', 'sql'])) throw incompatible
  if (objects.rows.length === 0) {
    if (!allowCreate) throw incompatible
    for (const sql of statements) {
      if (!isWrite(await tx.execute(sql), 0)) throw incompatible
    }
    const inserted = await tx.execute(
      'INSERT INTO fin_migrations (version,identity) VALUES (1,?)',
      [identity],
    )
    if (!isWrite(inserted, 1)) throw incompatible
  } else {
    if (
      objects.rows.length !== assets.length ||
      new Set(objects.rows.map((row) => row[0])).size !== assets.length
    )
      throw incompatible
    for (const row of objects.rows) {
      const asset = assets.find((a) => a.name === row[0])
      if (
        !asset ||
        row[1] !== asset.type ||
        typeof row[2] !== 'string' ||
        schemaTokens(row[2]) !== asset.tokens
      )
        throw incompatible
    }
  }
  const ledger = await tx.execute('SELECT version,identity FROM fin_migrations')
  if (
    !isProjection(ledger, ['version', 'identity']) ||
    ledger.rows.length !== 1 ||
    ledger.rows[0]?.[0] !== 1n ||
    ledger.rows[0][1] !== identity
  )
    throw incompatible
}
