import { FinError } from '@fin/provider'
import type {
  ChangeRecord,
  DomainChanges,
  DomainContext,
  FinStorage,
  MutationRequest,
} from '@fin/provider'
import { entityId, required } from './validation.js'

interface Planned<T> {
  changes: DomainChanges
  before: ChangeRecord['before']
  after: ChangeRecord['after']
  result: T
  balances?: ChangeRecord['balances']
}
export function change<T extends object>(
  storage: FinStorage,
  request: MutationRequest,
  target: ChangeRecord['target'],
  targetId: string,
  action: ChangeRecord['action'],
  decide: (
    context: Readonly<DomainContext>,
    token: string,
    now: string,
  ) => Planned<T> | { unchanged: T },
) {
  const token = crypto.randomUUID(),
    recordId = crypto.randomUUID(),
    now = new Date().toISOString()
  if ('vaultId' in request) entityId(request.vaultId)
  if ('id' in request && request.id !== undefined) entityId(request.id)
  return storage.mutate<T>(request, (context) => {
    if (context.vault?.archived && target !== 'vault')
      throw new FinError(
        'VAULT_ARCHIVED',
        'This vault is archived.',
        'Reactivate the vault before changing financial data.',
      )
    const plan = decide(context, token, now)
    if ('unchanged' in plan) return { kind: 'unchanged', result: plan.unchanged }
    const record: ChangeRecord = {
      id: recordId,
      vaultId: required('vaultId' in request ? request.vaultId : plan.changes.vault?.id),
      target,
      targetId,
      action,
      recordedAt: now,
      before: plan.before,
      after: plan.after,
      balances: plan.balances ?? [],
      ...(plan.changes.settings && context.settings
        ? { settings: { before: context.settings, after: plan.changes.settings } }
        : {}),
    }
    return { kind: 'changed', changes: plan.changes, record, result: plan.result }
  })
}
