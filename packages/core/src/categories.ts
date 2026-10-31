import type { Category, FinStorage } from '@fin/provider'
import { change } from './change.js'
import { invalid, label, required, revision } from './validation.js'

export class Categories {
  readonly #storage: FinStorage
  readonly #vaultId: string

  constructor(storage: FinStorage, vaultId: string) {
    this.#storage = storage
    this.#vaultId = vaultId
  }

  async listCategories(options: { includeArchived?: boolean } = {}) {
    return (await this.#storage.read({ kind: 'categories', vaultId: this.#vaultId, ...options }))
      .categories
  }

  async createCategory(input: { name: string; parentId?: string | null }) {
    const name = label(input.name),
      id = crypto.randomUUID(),
      parentId = input.parentId ?? null
    return change(
      this.#storage,
      { kind: 'category', vaultId: this.#vaultId, name, parentId },
      'category',
      id,
      'created',
      (c, token) => {
        invalid(
          !c.categories.some((a) => a.name === name && a.parentId === parentId),
          'Category names must be unique among siblings.',
        )
        const parent =
          parentId === null
            ? null
            : required(
                c.categories.find((a) => a.id === parentId),
                parentId,
              )
        invalid(!parent?.archived, 'An archived category cannot receive children.')
        const path = parent ? `${parent.path} / ${name}` : name
        invalid(
          path.split(' / ').length <= 3 && !name.includes(' / '),
          'Categories support at most three levels; names cannot contain the path separator.',
        )
        const category: Category = { id, revision: token, name, parentId, path, archived: false }
        return {
          changes: { categories: [category] },
          before: null,
          after: category,
          result: { changed: true, category },
        }
      },
    )
  }

  async updateCategory(input: {
    id: string
    expectedRevision: string
    patch: Partial<Pick<Category, 'name' | 'parentId' | 'archived'>>
  }) {
    const patch = { ...input.patch }
    if (patch.name !== undefined) patch.name = label(patch.name)
    return change<{ changed: boolean; category: Category }>(
      this.#storage,
      {
        kind: 'category',
        vaultId: this.#vaultId,
        id: input.id,
        name: patch.name,
        parentId: patch.parentId,
      },
      'category',
      input.id,
      'updated',
      (c, token) => {
        const before = required(
          c.categories.find((a) => a.id === input.id),
          input.id,
        )
        revision(before.revision, input.expectedRevision)
        const category = { ...before, ...patch }
        const parent =
          category.parentId === null
            ? null
            : required(
                c.categories.find((a) => a.id === category.parentId),
                category.parentId,
              )
        invalid(
          category.id !== parent?.id && !parent?.path.startsWith(`${before.path} / `),
          'A category cannot be moved into its own subtree.',
        )
        invalid(!parent?.archived, 'An archived category cannot receive children.')
        invalid(
          !c.categories.some(
            (a) =>
              a.id !== category.id && a.name === category.name && a.parentId === category.parentId,
          ),
          'Category names must be unique among siblings.',
        )
        category.path = parent ? `${parent.path} / ${category.name}` : category.name
        invalid(
          !category.name.includes(' / ') && typeof category.archived === 'boolean',
          'Invalid category name or archived flag.',
        )
        for (const descendant of c.categories.filter((a) =>
          a.path.startsWith(`${before.path} / `),
        )) {
          invalid(
            `${category.path}${descendant.path.slice(before.path.length)}`.split(' / ').length <= 3,
            'Moving this subtree would exceed three levels.',
          )
        }
        invalid(category.path.split(' / ').length <= 3, 'Categories support at most three levels.')
        if (JSON.stringify(category) === JSON.stringify(before))
          return { unchanged: { changed: false, category: before } }
        category.revision = token
        return {
          changes: { categories: [category] },
          before,
          after: category,
          result: { changed: true, category },
        }
      },
    )
  }
}
