import type Database from 'better-sqlite3'
import { getTableColumns, getTableName } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { FinError } from '@fin/provider'
import * as schema from './schema.js'

export class SchemaManager {
  readonly #db: Database.Database
  readonly #orm: BetterSQLite3Database
  readonly #autoMigrate: boolean

  constructor(db: Database.Database, orm: BetterSQLite3Database, autoMigrate: boolean) {
    this.#db = db
    this.#orm = orm
    this.#autoMigrate = autoMigrate
  }

  #schemaFailure(message: string): never {
    throw new FinError(
      'SCHEMA_INCOMPATIBLE',
      message,
      'Run the supported migration explicitly, or open a compatible database. Do not overwrite existing fin data.',
    )
  }
  #checkSchema(): boolean {
    const names = this.#db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type IN ('table','view') AND substr(name,1,4)='fin_'",
      )
      .all()
      .map((r) => r.name)
    if (!names.length) return false
    const tables = [
      schema.migrations,
      schema.vaults,
      schema.settings,
      schema.accounts,
      schema.categories,
      schema.transactions,
      schema.assignments,
      schema.relations,
      schema.history,
    ]
    if (!names.includes('fin_category_paths'))
      this.#schemaFailure('The current category-path view is missing.')
    if (tables.some((t) => !names.includes(getTableName(t))))
      this.#schemaFailure('The fin schema is incomplete or has no migration ledger.')
    for (const table of tables) {
      const columns = this.#db
        .prepare<[], { name: string }>(`PRAGMA table_info("${getTableName(table)}")`)
        .all()
        .map((c) => c.name)
      if (Object.values(getTableColumns(table)).some((c) => !columns.includes(c.name)))
        this.#schemaFailure('The fin schema does not match its migration ledger.')
    }
    const ledger = this.#orm.select().from(schema.migrations).all()
    if (
      ledger.length !== 1 ||
      ledger[0]?.version !== 1 ||
      ledger[0].identity !== schema.initialMigration
    )
      this.#schemaFailure('The migration ledger is unknown or does not match the supported assets.')
    return true
  }
  prepare() {
    this.#db.pragma('foreign_keys = ON')
    this.#db
      .transaction(() => {
        if (this.#checkSchema()) return
        this.#db.exec(schema.initialMigration)
        this.#db.exec(
          'CREATE TABLE fin_migrations (version INTEGER PRIMARY KEY, identity TEXT NOT NULL)',
        )
        this.#orm
          .insert(schema.migrations)
          .values({ version: 1, identity: schema.initialMigration })
          .run()
      })
      .immediate()
  }
  ready() {
    this.#db.pragma('foreign_keys = ON')
    if (!this.#checkSchema()) {
      if (!this.#autoMigrate) this.#schemaFailure('The fin schema has not been initialized.')
      this.prepare()
    }
  }
}
