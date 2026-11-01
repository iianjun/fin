import { integer, primaryKey, sqliteTable, sqliteView, text } from 'drizzle-orm/sqlite-core'
import type { ChangeRecord } from '@fin/provider'

export const migrations = sqliteTable('fin_migrations', {
  version: integer().primaryKey(),
  identity: text().notNull(),
})

export const vaults = sqliteTable('fin_vaults', {
  id: text().primaryKey(),
  name: text().notNull(),
  revision: text().notNull(),
  archived: integer({ mode: 'boolean' }).notNull(),
  generation: text().notNull(),
  stamp: integer().notNull(),
})
export const settings = sqliteTable('fin_settings', {
  vaultId: text()
    .primaryKey()
    .references(() => vaults.id),
  revision: text().notNull(),
  incomeAccountId: text(),
  expenseAccountId: text(),
})
export const history = sqliteTable(
  'fin_change_records',
  {
    vaultId: text()
      .notNull()
      .references(() => vaults.id),
    id: text().notNull(),
    targetId: text().notNull(),
    payload: text({ mode: 'json' }).$type<ChangeRecord>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.vaultId, t.id] })],
)
export const accounts = sqliteTable(
  'fin_accounts',
  {
    vaultId: text()
      .notNull()
      .references(() => vaults.id),
    id: text().notNull(),
    name: text().notNull(),
    revision: text().notNull(),
    balanceRevision: text().notNull(),
    nature: text({ enum: ['asset', 'liability'] }).notNull(),
    currency: text().notNull(),
    archived: integer({ mode: 'boolean' }).notNull(),
    hasTransactions: integer({ mode: 'boolean' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.vaultId, t.id] })],
)
export const categories = sqliteTable(
  'fin_categories',
  {
    vaultId: text()
      .notNull()
      .references(() => vaults.id),
    id: text().notNull(),
    revision: text().notNull(),
    name: text().notNull(),
    parentId: text(),
    archived: integer({ mode: 'boolean' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.vaultId, t.id] })],
)
export const categoryPaths = sqliteView('fin_category_paths', {
  vaultId: text().notNull(),
  id: text().notNull(),
  revision: text().notNull(),
  name: text().notNull(),
  parentId: text(),
  archived: integer({ mode: 'boolean' }).notNull(),
  path: text().notNull(),
}).existing()
export const transactions = sqliteTable(
  'fin_transactions',
  {
    vaultId: text()
      .notNull()
      .references(() => vaults.id),
    id: text().notNull(),
    revision: text().notNull(),
    kind: text({ enum: ['income', 'expense', 'adjustment', 'transfer'] }).notNull(),
    occurredOn: text().notNull(),
    memo: text(),
    accountId: text(),
    amountMinor: integer(),
    sourceAccountId: text(),
    sourceAmountMinor: integer(),
    destinationAccountId: text(),
    destinationAmountMinor: integer(),
  },
  (t) => [primaryKey({ columns: [t.vaultId, t.id] })],
)
export const assignments = sqliteTable(
  'fin_category_assignments',
  {
    vaultId: text().notNull(),
    transactionId: text().notNull(),
    categoryId: text().notNull(),
    amountMinor: integer().notNull(),
    origin: text({ enum: ['explicit', 'inferred'] }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.vaultId, t.transactionId, t.categoryId] })],
)
export const relations = sqliteTable(
  'fin_transaction_relations',
  {
    vaultId: text().notNull(),
    sourceId: text().notNull(),
    targetTransactionId: text().notNull(),
    kind: text({ enum: ['refund_of', 'fee_for'] }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.vaultId, t.sourceId, t.targetTransactionId, t.kind] })],
)

export const initialMigration = `
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
CREATE TABLE fin_commit_guards (id TEXT PRIMARY KEY NOT NULL, ok INTEGER NOT NULL CONSTRAINT fin_snapshot_current CHECK(ok=1));
CREATE VIEW fin_category_paths AS WITH RECURSIVE paths(vaultId,id,revision,name,parentId,archived,path,depth) AS (SELECT vaultId,id,revision,name,parentId,archived,name,1 FROM fin_categories WHERE parentId IS NULL UNION ALL SELECT c.vaultId,c.id,c.revision,c.name,c.parentId,c.archived,p.path || ' / ' || c.name,p.depth+1 FROM fin_categories c JOIN paths p ON c.vaultId=p.vaultId AND c.parentId=p.id WHERE p.depth<3) SELECT vaultId,id,revision,name,parentId,archived,path FROM paths;
`
