import type { ExecutorServiceIdentity } from '../../application/ports/executorRuntime'
import type { CodexAppServerProcess } from './CodexAppServerProcess'

/** Pid 1 or less would turn a group kill into a signal to processes that are not ours. */
export function serviceIdentityOf(
  process: Pick<CodexAppServerProcess, 'pid' | 'tokenSha256'>,
): ExecutorServiceIdentity | null {
  return process.pid > 1 ? { pid: process.pid, tokenSha256: process.tokenSha256 } : null
}
