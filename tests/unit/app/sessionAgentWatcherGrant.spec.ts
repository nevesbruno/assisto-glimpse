// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { createControlSurface } from '../../../src/app/main/controlSurface/controlSurface'
import { registerSessionAgentWatcherHandlers } from '../../../src/app/main/controlSurface/handlers/sessionAgentWatcherHandlers'
import { grantContext, twoProjectGrantStore } from '../../support/grantStateStore'

const attach = (sessionId: string) => ({
  sessionId,
  provider: 'codex',
  cwd: '/a',
  launchMode: 'new',
  startedAtMs: 1,
  resumeSessionId: null,
})

async function setup(withStore = true) {
  const store = await twoProjectGrantStore()
  const ptyRuntime = { startSessionStateWatcher: vi.fn(), disposeSessionStateWatcher: vi.fn() }
  const ptyStreamHub = {
    hasSession: (id: string) => ['sess-a', 'sess-b'].includes(id),
    hasNativePiObservation: () => false,
  }
  const control = createControlSurface()
  registerSessionAgentWatcherHandlers(control, {
    approvedWorkspaces: { isPathApproved: async () => true } as never,
    ptyRuntime: ptyRuntime as never,
    ptyStreamHub: ptyStreamHub as never,
    getPersistenceStore: withStore ? async () => store : undefined,
  })
  const invoke = (ctx: object, id: string, payload: unknown) =>
    control.invoke(ctx as never, { kind: 'command', id, payload } as never)
  return { ptyRuntime, invoke }
}

describe('agent state watcher under a grant', () => {
  it('refuses attach to a session of another project like an unknown one', async () => {
    vi.stubEnv('VITEST', '')
    const { ptyRuntime, invoke } = await setup()
    const denied = await invoke(
      grantContext('project-a'),
      'session.attachAgentStateWatcher',
      attach('sess-b'),
    )
    const ghost = await invoke(
      grantContext('project-a'),
      'session.attachAgentStateWatcher',
      attach('ghost'),
    )
    expect(denied.ok).toBe(false)
    expect(JSON.parse(JSON.stringify(denied).replace('sess-b', '<id>'))).toEqual(
      JSON.parse(JSON.stringify(ghost).replace('ghost', '<id>')),
    )
    expect(ptyRuntime.startSessionStateWatcher).not.toHaveBeenCalled()
    vi.unstubAllEnvs()
  })

  it('accepts attach to the own session and for a user without grant', async () => {
    const { invoke } = await setup()
    expect(
      (await invoke(grantContext('project-a'), 'session.attachAgentStateWatcher', attach('sess-a')))
        .ok,
    ).toBe(true)
    expect(
      (await invoke({ now: () => new Date() }, 'session.attachAgentStateWatcher', attach('sess-b')))
        .ok,
    ).toBe(true)
  })

  it('keeps the watcher of another project on detach and answers like an unknown session', async () => {
    const { ptyRuntime, invoke } = await setup()
    const denied = await invoke(grantContext('project-a'), 'session.detachAgentStateWatcher', {
      sessionId: 'sess-b',
    })
    const ghost = await invoke(grantContext('project-a'), 'session.detachAgentStateWatcher', {
      sessionId: 'ghost',
    })
    expect(denied).toEqual(ghost)
    expect(ptyRuntime.disposeSessionStateWatcher).not.toHaveBeenCalled()
    await invoke(grantContext('project-a'), 'session.detachAgentStateWatcher', {
      sessionId: 'sess-a',
    })
    expect(ptyRuntime.disposeSessionStateWatcher).toHaveBeenCalledWith('sess-a')
  })

  it('denies a grant when no store is wired', async () => {
    const { ptyRuntime, invoke } = await setup(false)
    expect(
      (await invoke(grantContext('project-a'), 'session.attachAgentStateWatcher', attach('sess-a')))
        .ok,
    ).toBe(false)
    await invoke(grantContext('project-a'), 'session.detachAgentStateWatcher', {
      sessionId: 'sess-a',
    })
    expect(ptyRuntime.disposeSessionStateWatcher).not.toHaveBeenCalled()
  })
})
