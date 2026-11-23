import { describe, expect, it, vi } from 'vitest'
import type {
  ExecutorRuntime,
  ExecutorRuntimeEvent,
  ExecutorServiceIdentity,
} from '../../../src/contexts/orchestration/application/ports'
import { CodexWriterLockRecoveryExhaustedError } from '../../../src/app/main/controlSurface/handlers/codexResumeRecovery'
import { withCodexWriterLockRecovery } from '../../../src/app/main/controlSurface/orchestration/codexWriterLockRuntime'

function fakeRuntime(ensureSession: ExecutorRuntime['ensureSession']): {
  runtime: ExecutorRuntime
  calls: string[]
} {
  const calls: string[] = []
  const runtime: ExecutorRuntime = {
    ensureSession,
    startTurn: async () => ({ turnRef: 'turn-1' }),
    findTurnByDispatch: async () => ({ kind: 'unknown' }),
    readTurn: async () => ({
      turnRef: 'turn-1',
      status: 'completed',
      finalMessage: null,
      usage: null,
    }),
    respondApproval: async () => ({ ok: true }),
    interrupt: async () => undefined,
    attachInfo: async () => ({
      url: 'ws://127.0.0.1:9',
      tokenEnv: { name: 'TOKEN', value: 'secret' },
      sessionRef: 'thr-1',
      cwd: '/w',
    }),
    serviceIdentity: async (): Promise<ExecutorServiceIdentity | null> => ({
      pid: 42,
      tokenSha256: 'a'.repeat(64),
    }),
    subscribe: (_listener: (event: ExecutorRuntimeEvent) => void) => () => undefined,
    close: async reason => {
      calls.push(`close:${reason}`)
    },
  }
  return { runtime, calls }
}

const activeWriter = () => Object.assign(new Error('-32600 already has an active writer'), {})

describe('withCodexWriterLockRecovery', () => {
  it('ends the matching holder and resumes again on the same runtime', async () => {
    const ensureSession = vi
      .fn<ExecutorRuntime['ensureSession']>()
      .mockRejectedValueOnce(activeWriter())
      .mockResolvedValueOnce({ sessionRef: 'thr-1', resumed: true })
    const { runtime } = fakeRuntime(ensureSession)
    const recover = vi.fn(async () => ({ outcome: 'released' as const, killedPids: [77] }))

    const wrapped = withCodexWriterLockRecovery(runtime, { recover })

    await expect(wrapped.ensureSession({ resumeRef: 'thr-1', fresh: false })).resolves.toEqual({
      sessionRef: 'thr-1',
      resumed: true,
    })
    expect(ensureSession).toHaveBeenCalledTimes(2)
    expect(recover).toHaveBeenCalledWith('thr-1')
  })

  it('does not kill a stranger and fails closed reporting the owners', async () => {
    const ensureSession = vi
      .fn<ExecutorRuntime['ensureSession']>()
      .mockRejectedValue(activeWriter())
    const { runtime } = fakeRuntime(ensureSession)
    const owners = [{ pid: 77, commandLine: 'codex app-server --ws-token-sha256 bbb' }]
    const recover = vi.fn(async () => ({ outcome: 'held' as const, killedPids: [], owners }))

    const wrapped = withCodexWriterLockRecovery(runtime, { recover })

    await expect(
      wrapped.ensureSession({ resumeRef: 'thr-1', fresh: false }),
    ).rejects.toBeInstanceOf(CodexWriterLockRecoveryExhaustedError)
    expect(ensureSession).toHaveBeenCalledTimes(1)
    expect(recover).toHaveBeenCalledTimes(1)
  })

  it('passes a non-writer error through without touching the lock', async () => {
    const ensureSession = vi
      .fn<ExecutorRuntime['ensureSession']>()
      .mockRejectedValue(Object.assign(new Error('no rollout'), { code: 'executor.session_lost' }))
    const { runtime } = fakeRuntime(ensureSession)
    const recover = vi.fn()

    const wrapped = withCodexWriterLockRecovery(runtime, { recover })

    await expect(wrapped.ensureSession({ resumeRef: 'thr-1', fresh: false })).rejects.toMatchObject(
      { code: 'executor.session_lost' },
    )
    expect(recover).not.toHaveBeenCalled()
  })

  it('delegates the remaining runtime surface to the wrapped service', async () => {
    const ensureSession = vi.fn<ExecutorRuntime['ensureSession']>()
    const { runtime, calls } = fakeRuntime(ensureSession)
    const wrapped = withCodexWriterLockRecovery(runtime, { recover: vi.fn() })

    await expect(wrapped.attachInfo()).resolves.toMatchObject({ sessionRef: 'thr-1' })
    await expect(wrapped.serviceIdentity()).resolves.toMatchObject({ pid: 42 })
    await wrapped.close('restart')
    expect(calls).toEqual(['close:restart'])
  })
})
