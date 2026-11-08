import { AsyncLocalStorage } from 'node:async_hooks'
import { FinError } from '@fin/provider'
import type {
  DomainContext,
  FinStorage,
  MutationDecision,
  MutationRequest,
  ReadRequest,
} from '@fin/provider'
import { TursoProtocol } from './protocol.js'
import type { OperationSession } from './protocol.js'
import { prepareSchema } from './schema.js'
import { readContext, writeChanges } from './storage.js'

export interface TursoAdapterOptions {
  url: string
  authToken: string
  autoMigrate?: boolean
  allowedRouteOrigins?: readonly string[]
  timeoutMs?: number
  fetch?: typeof fetch
}

// Construction validates settings without opening a stream or doing network I/O.
export function createTursoAdapter(options: TursoAdapterOptions): FinStorage & {
  migrate(): Promise<void>
  close(): Promise<void>
} {
  if (!options || (options.autoMigrate !== undefined && typeof options.autoMigrate !== 'boolean'))
    throw new FinError(
      'INVALID_INPUT',
      'Invalid Turso adapter settings.',
      'Supply connection settings and an optional boolean autoMigrate.',
    )
  const protocol = new TursoProtocol(options)
  const autoMigrate = options.autoMigrate ?? true
  const decisionScope = new AsyncLocalStorage<{ nested: boolean }>()

  function execute<T>(
    operation: (tx: OperationSession) => Promise<T>,
    migrate = false,
  ): Promise<T> {
    const scope = decisionScope.getStore()
    if (scope) {
      scope.nested = true
      const rejection = Promise.reject<T>(
        new FinError(
          'INVALID_INPUT',
          'Storage operations cannot be nested in a mutation decision.',
          'Keep the decision synchronous and free of storage operations.',
        ),
      )
      void rejection.catch(() => {})
      return rejection
    }
    // Transport admission is synchronous. A close immediately after this call
    // includes schema checking, context loading, writes and release in its drain.
    return protocol.immediate(async (tx) => {
      try {
        await prepareSchema(tx, migrate || autoMigrate)
        return await operation(tx)
      } catch (error) {
        if (error instanceof FinError) throw error
        throw new FinError(
          'STORAGE_FAILURE',
          'The Turso storage operation failed.',
          'Inspect connection, schema and stored data before deciding whether to submit a new operation.',
        )
      }
    })
  }

  return {
    migrate(): Promise<void> {
      return execute(async () => {}, true)
    },

    close(): Promise<void> {
      const scope = decisionScope.getStore()
      if (scope) {
        scope.nested = true
        const rejection = Promise.reject<void>(
          new FinError(
            'INVALID_INPUT',
            'Storage cannot close inside a mutation decision.',
            'Close the adapter after the operation settles.',
          ),
        )
        void rejection.catch(() => {})
        return rejection
      }
      return protocol.close()
    },

    read(request: ReadRequest): Promise<DomainContext> {
      return execute((tx) => readContext(tx, request))
    },

    mutate<T>(
      request: MutationRequest,
      decide: (context: Readonly<DomainContext>) => MutationDecision<T>,
    ): Promise<T> {
      return execute(async (tx) => {
        const context = await readContext(tx, request)
        const scope = { nested: false }
        const decision = decisionScope.run(scope, () => decide(context))
        if (decision && typeof decision === 'object' && 'then' in decision) {
          // Observe rejected async decisions without awaiting them or permitting a
          // write. The callback is never rerun; its asynchronous work is invalid.
          void Promise.resolve(decision).catch(() => {})
          throw new FinError(
            'INVALID_INPUT',
            'Mutation decisions must be synchronous.',
            'Return a synchronous decision without I/O.',
          )
        }
        if (scope.nested)
          throw new FinError(
            'INVALID_INPUT',
            'A mutation decision attempted a nested storage operation.',
            'Keep decisions synchronous and free of storage operations.',
          )
        if (!decision || (decision.kind !== 'changed' && decision.kind !== 'unchanged'))
          throw new FinError(
            'INVALID_INPUT',
            'Invalid mutation decision.',
            'Return a changed or unchanged decision.',
          )
        if (decision.kind === 'changed')
          await writeChanges(tx, request, decision.changes, decision.record)
        return decision.result
      })
    },
  }
}
