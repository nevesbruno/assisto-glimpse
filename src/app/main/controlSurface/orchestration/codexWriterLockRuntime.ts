/* oxlint-disable no-await-in-loop -- each resume attempt must fail before the next one starts */
import type {
  ExecutorRuntime,
  EnsureSessionInput,
  EnsureSessionResult,
} from '../../../../contexts/orchestration/application/ports'
import {
  CodexWriterLockRecoveryExhaustedError,
  isCodexActiveWriterError,
  type CodexWriterLockOwner,
  type CodexWriterLockRecoveryResult,
} from '../handlers/codexResumeRecovery'

export interface CodexWriterLockRuntimeOptions {
  /** Ends the matching app-server and reports whether the lock was released. */
  readonly recover: (resumeRef: string) => Promise<CodexWriterLockRecoveryResult>
  readonly maxAttempts?: number
}

const MAX_RESUME_ATTEMPTS = 3

/**
 * A thread lock left by the crash makes the first resume fail; when the holder is ours the
 * recovery ends it and the very same service resumes again. A stranger holder is never killed:
 * the boot keeps the link unchanged and retries with its own backoff.
 */
export function withCodexWriterLockRecovery(
  runtime: ExecutorRuntime,
  options: CodexWriterLockRuntimeOptions,
): ExecutorRuntime {
  const maxAttempts = Math.max(1, Math.min(MAX_RESUME_ATTEMPTS, options.maxAttempts ?? 2))
  let owners: readonly CodexWriterLockOwner[] = []

  const ensureSession = async (input: EnsureSessionInput): Promise<EnsureSessionResult> => {
    let lastError: unknown = null
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await runtime.ensureSession(input)
      } catch (error) {
        lastError = error
        if (!isCodexActiveWriterError(error) || input.resumeRef === null) {
          throw error
        }
        if (attempt >= maxAttempts) {
          break
        }
        const recovery = await options.recover(input.resumeRef)
        owners = 'owners' in recovery ? recovery.owners : []
        if (recovery.outcome !== 'released') {
          throw new CodexWriterLockRecoveryExhaustedError(error, owners)
        }
      }
    }
    throw new CodexWriterLockRecoveryExhaustedError(lastError, owners)
  }

  return {
    ensureSession,
    startTurn: input => runtime.startTurn(input),
    findTurnByDispatch: (dispatchId, since) => runtime.findTurnByDispatch(dispatchId, since),
    readTurn: turnRef => runtime.readTurn(turnRef),
    respondApproval: (requestId, decision) => runtime.respondApproval(requestId, decision),
    interrupt: turnRef => runtime.interrupt(turnRef),
    attachInfo: () => runtime.attachInfo(),
    serviceIdentity: () => runtime.serviceIdentity(),
    subscribe: listener => runtime.subscribe(listener),
    close: reason => runtime.close(reason),
  }
}
