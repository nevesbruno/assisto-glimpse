import { OrchestrationError } from '../domain/agentLink'

/** Codes the runtime raises when it refused the request before writing anything to the service. */
const REFUSED_BEFORE_WRITE = new Set([
  'executor.rejected',
  'executor.busy',
  'executor.unavailable',
  'executor.session_lost',
  'executor.unsupported',
])

function codeOf(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : null
}

export function isRefusedBeforeWrite(error: unknown): boolean {
  const code = codeOf(error)
  return code !== null && REFUSED_BEFORE_WRITE.has(code)
}

/** The single place where an `executor.*` error of the runtime port becomes an `orch.*` one. */
export function translateRuntimeError(error: unknown): unknown {
  const code = codeOf(error)
  if (code === 'executor.protocol_mismatch') {
    return new OrchestrationError('orch.protocol_mismatch')
  }
  return code?.startsWith('executor.') ? new OrchestrationError('orch.executor_unavailable') : error
}

/** Every call to the runtime outside the turn send goes through here. */
export async function callRuntime<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (error) {
    throw translateRuntimeError(error)
  }
}
