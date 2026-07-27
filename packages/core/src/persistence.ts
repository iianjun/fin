import type { DatabaseSync } from 'node:sqlite'

export type ChangeRecordEntityType = 'vault_settings' | 'account' | 'category' | 'transaction'
export type ChangeRecordAction = 'created' | 'updated' | 'deleted'

export function insertChangeRecord(
  database: DatabaseSync,
  entityType: ChangeRecordEntityType,
  entityId: string,
  action: ChangeRecordAction,
  payload: object,
): void {
  database
    .prepare(
      `INSERT INTO change_records (entity_type, entity_id, action, payload)
       VALUES (?, ?, ?, json(?))`,
    )
    .run(entityType, entityId, action, JSON.stringify(payload))
}

export function runMutation<Result>(database: DatabaseSync, mutation: () => Result): Result {
  database.exec('BEGIN IMMEDIATE')

  try {
    const result = mutation()
    database.exec('COMMIT')
    return result
  } catch (error) {
    try {
      database.exec('ROLLBACK')
    } catch {
      // Preserve the mutation error if SQLite already rolled the transaction back.
    }

    throw error
  }
}
