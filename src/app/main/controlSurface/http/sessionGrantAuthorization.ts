import { getControlSurfaceOperation } from '../../../../shared/contracts/controlSurface/operations'

const STATE_WRITE_OPERATIONS = new Set(['sync.writeState', 'sync.writeWorkspaceStateRaw'])

export function sessionGrantAllowsOperation(
  id: string,
  tier: 'read' | 'interact' = 'interact',
): boolean {
  if (
    id.startsWith('worker.') ||
    id === 'auth.issueWebSessionTicket' ||
    STATE_WRITE_OPERATIONS.has(id)
  ) {
    return false
  }
  const operation = getControlSurfaceOperation(id)
  return operation?.scope === 'read' || (tier === 'interact' && operation?.scope === 'interact')
}
