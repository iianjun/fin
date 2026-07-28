import type { DatabaseSync } from 'node:sqlite'
import { FinError } from './errors.js'
import { insertChangeRecord, runMutation } from './persistence.js'
import { withVaultDatabase } from './vault.js'

export type Category = {
  id: number
  parentId: number | null
  name: string
  depth: number
  path: string
  archived: boolean
}

export type CategoryCreation = {
  name: string
  parentId?: number | null | undefined
}

export type CategoryUpdate = {
  name?: string | undefined
  parentId?: number | null | undefined
}

export type CreateCategoryResult = {
  action: 'created'
  category: Category
}

export type CategoryMutation = 'details_updated' | 'archived' | 'reactivated'

export type CategoryMutationResult = {
  action: 'updated'
  mutation: CategoryMutation
  previousCategory: Category
  category: Category
}

type CategoryRow = {
  id: number
  parent_id: number | null
  name: string
  depth: number
  path: string
  archived_at: string | null
}

export function createCategory(
  vaultPath: string,
  creation: CategoryCreation,
): CreateCategoryResult {
  const name = normalizeCategoryName(creation.name)
  const parentId =
    creation.parentId === undefined || creation.parentId === null
      ? null
      : validateCategoryId(creation.parentId)

  return withVaultDatabase(vaultPath, (database) =>
    runMutation(database, () => {
      if (parentId !== null) {
        const parent = readCategory(database, parentId)
        ensureActiveParent(parent)

        if (parent.depth >= 3) {
          throw new Error(
            `Category "${name}" cannot be created under "${parent.path}" because Category ` +
              'paths cannot exceed three levels',
          )
        }
      }

      ensureUniqueSiblingName(database, name, parentId)

      const categoryId = Number(
        database
          .prepare(
            `INSERT INTO categories (parent_id, name)
             VALUES (?, ?)`,
          )
          .run(parentId, name).lastInsertRowid,
      )
      const category = readCategory(database, categoryId)
      const result = { action: 'created' as const, category }

      insertChangeRecord(database, 'category', String(categoryId), 'created', result)

      return result
    }),
  )
}

export function listCategories(vaultPath: string): Category[] {
  return withVaultDatabase(vaultPath, (database) => {
    const rows = database
      .prepare(
        `SELECT id, parent_id, name, depth, path, archived_at
         FROM category_paths
         ORDER BY path COLLATE NOCASE, id`,
      )
      .all() as CategoryRow[]

    return rows.map(mapCategoryRow)
  })
}

export function updateCategory(
  vaultPath: string,
  categoryId: number,
  update: CategoryUpdate,
): CategoryMutationResult {
  const validatedCategoryId = validateCategoryId(categoryId)
  const normalizedName = update.name === undefined ? undefined : normalizeCategoryName(update.name)
  const validatedParentId =
    update.parentId === undefined || update.parentId === null
      ? update.parentId
      : validateCategoryId(update.parentId)

  if (normalizedName === undefined && validatedParentId === undefined) {
    throw new Error('A Category name or parent must be supplied to update')
  }

  return withVaultDatabase(vaultPath, (database) =>
    runMutation(database, () => {
      const previousCategory = readCategory(database, validatedCategoryId)
      const name = normalizedName ?? previousCategory.name
      const parentId =
        validatedParentId === undefined ? previousCategory.parentId : validatedParentId

      if (name === previousCategory.name && parentId === previousCategory.parentId) {
        throw new Error(`Category ${validatedCategoryId} already has the requested values`)
      }

      if (parentId === validatedCategoryId) {
        throw new Error(`Category ${validatedCategoryId} cannot be its own parent`)
      }

      if (parentId !== null) {
        const parent = readCategory(database, parentId)
        ensureActiveParent(parent)

        if (isDescendant(database, validatedCategoryId, parentId)) {
          throw new Error(
            `Category "${previousCategory.path}" cannot move under its own descendant ` +
              `"${parent.path}" because Category paths cannot contain cycles`,
          )
        }

        ensureSubtreeFitsDepth(database, validatedCategoryId, parent.depth, name, parent.path)
      } else {
        ensureSubtreeFitsDepth(database, validatedCategoryId, 0, name, null)
      }

      ensureUniqueSiblingName(database, name, parentId, validatedCategoryId)

      database
        .prepare(
          `UPDATE categories
           SET
             parent_id = ?,
             name = ?,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           WHERE id = ?`,
        )
        .run(parentId, name, validatedCategoryId)

      return recordCategoryMutation(database, 'details_updated', previousCategory)
    }),
  )
}

export function archiveCategory(vaultPath: string, categoryId: number): CategoryMutationResult {
  const validatedCategoryId = validateCategoryId(categoryId)

  return withVaultDatabase(vaultPath, (database) =>
    runMutation(database, () => {
      const previousCategory = readCategory(database, validatedCategoryId)

      if (previousCategory.archived) {
        throw new Error(`Category ${validatedCategoryId} ("${previousCategory.path}") is archived`)
      }

      const activeChild = database
        .prepare(
          `SELECT name
           FROM categories
           WHERE parent_id = ? AND archived_at IS NULL
           ORDER BY id
           LIMIT 1`,
        )
        .get(validatedCategoryId) as { name: string } | undefined

      if (activeChild) {
        throw new Error(
          `Category "${previousCategory.path}" cannot be archived while it has active child ` +
            `Category "${activeChild.name}". Archive active children first.`,
        )
      }

      database
        .prepare(
          `UPDATE categories
           SET
             archived_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           WHERE id = ?`,
        )
        .run(validatedCategoryId)

      return recordCategoryMutation(database, 'archived', previousCategory)
    }),
  )
}

export function reactivateCategory(vaultPath: string, categoryId: number): CategoryMutationResult {
  const validatedCategoryId = validateCategoryId(categoryId)

  return withVaultDatabase(vaultPath, (database) =>
    runMutation(database, () => {
      const previousCategory = readCategory(database, validatedCategoryId)

      if (!previousCategory.archived) {
        throw new Error(`Category ${validatedCategoryId} ("${previousCategory.path}") is active`)
      }

      if (previousCategory.parentId !== null) {
        ensureActiveParent(readCategory(database, previousCategory.parentId))
      }

      database
        .prepare(
          `UPDATE categories
           SET
             archived_at = NULL,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           WHERE id = ?`,
        )
        .run(validatedCategoryId)

      return recordCategoryMutation(database, 'reactivated', previousCategory)
    }),
  )
}

function normalizeCategoryName(name: string): string {
  const normalizedName = name.trim()

  if (normalizedName.length === 0) {
    throw new Error('Category name must not be empty')
  }

  return normalizedName
}

function validateCategoryId(categoryId: number): number {
  if (!Number.isSafeInteger(categoryId) || categoryId <= 0) {
    throw new Error('Category ID must be a positive integer')
  }

  return categoryId
}

function ensureActiveParent(parent: Category): void {
  if (parent.archived) {
    throw new Error(
      `Archived Category ${parent.id} ("${parent.path}") cannot receive active children`,
    )
  }
}

function ensureUniqueSiblingName(
  database: DatabaseSync,
  name: string,
  parentId: number | null,
  excludedCategoryId?: number,
): void {
  const existingCategory = database
    .prepare(
      `SELECT id, name
       FROM categories
       WHERE parent_id IS ?
         AND name = ? COLLATE NOCASE
         AND (? IS NULL OR id != ?)`,
    )
    .get(parentId, name, excludedCategoryId ?? null, excludedCategoryId ?? null) as
    | { id: number; name: string }
    | undefined

  if (existingCategory) {
    const location = parentId === null ? 'the Vault root' : `parent Category ${parentId}`

    throw new Error(
      `Category name "${name}" is already used by sibling Category ${existingCategory.id} ` +
        `("${existingCategory.name}") under ${location}. Choose a unique sibling name.`,
    )
  }
}

function isDescendant(database: DatabaseSync, categoryId: number, possibleDescendantId: number) {
  const row = database
    .prepare(
      `WITH RECURSIVE descendants (id) AS (
         SELECT id
         FROM categories
         WHERE parent_id = ?

         UNION ALL

         SELECT categories.id
         FROM categories
         JOIN descendants ON categories.parent_id = descendants.id
       )
       SELECT EXISTS (
         SELECT 1
         FROM descendants
         WHERE id = ?
       ) AS is_descendant`,
    )
    .get(categoryId, possibleDescendantId) as { is_descendant: number }

  return row.is_descendant === 1
}

function ensureSubtreeFitsDepth(
  database: DatabaseSync,
  categoryId: number,
  parentDepth: number,
  name: string,
  parentPath: string | null,
): void {
  const row = database
    .prepare(
      `WITH RECURSIVE descendants (id, relative_depth) AS (
         SELECT id, 1
         FROM categories
         WHERE id = ?

         UNION ALL

         SELECT categories.id, descendants.relative_depth + 1
         FROM categories
         JOIN descendants ON categories.parent_id = descendants.id
       )
       SELECT max(relative_depth) AS subtree_depth
       FROM descendants`,
    )
    .get(categoryId) as { subtree_depth: number }

  if (parentDepth + row.subtree_depth > 3) {
    const proposedPath = parentPath === null ? name : `${parentPath} > ${name}`

    throw new Error(
      `Category "${proposedPath}" and its children cannot fit because Category paths ` +
        'cannot exceed three levels',
    )
  }
}

function readCategory(database: DatabaseSync, categoryId: number): Category {
  const row = database
    .prepare(
      `SELECT id, parent_id, name, depth, path, archived_at
       FROM category_paths
       WHERE id = ?`,
    )
    .get(categoryId) as CategoryRow | undefined

  if (!row) {
    throw new FinError('ENTITY_NOT_FOUND', `Category ${categoryId} does not exist`, {
      entityType: 'category',
      entityId: categoryId,
    })
  }

  return mapCategoryRow(row)
}

function mapCategoryRow(row: CategoryRow): Category {
  return {
    id: row.id,
    parentId: row.parent_id,
    name: row.name,
    depth: row.depth,
    path: row.path,
    archived: row.archived_at !== null,
  }
}

function recordCategoryMutation(
  database: DatabaseSync,
  mutation: CategoryMutation,
  previousCategory: Category,
): CategoryMutationResult {
  const category = readCategory(database, previousCategory.id)
  const result = {
    action: 'updated' as const,
    mutation,
    previousCategory,
    category,
  }

  insertChangeRecord(database, 'category', String(category.id), 'updated', result)

  return result
}
