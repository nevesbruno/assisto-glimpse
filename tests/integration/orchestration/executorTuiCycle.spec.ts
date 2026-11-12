// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ControlSurfacePtyRuntime } from '../../../src/app/main/controlSurface/handlers/sessionPtyRuntime'
import { createLiveSessions } from '../../../src/app/main/controlSurface/orchestration/composeOrchestrationDeps'
import {
  createExecutorTuiLauncher,
  RELAUNCH_KILL_DELAY_MS,
} from '../../../src/app/main/controlSurface/orchestration/executorTuiLauncher'
import type { ExecutorTuiLauncher } from '../../../src/contexts/orchestration/application/ports'
import { createInMemoryPersistenceStore } from '../../contract/controlSurface/controlSurfaceHttpServer.sessionStreaming.testUtils'
import {
  bootedHarness,
  ORCHESTRATOR,
  orchestratorPrincipal,
  USER,
} from '../../unit/contexts/orchestration/application/fakes'

const EXECUTOR = 'exec-1'

const terminalNode = {
  id: EXECUTOR,
  sessionId: 'dead-session',
  title: 'executor',
  titlePinnedByUser: false,
  position: { x: 0, y: 0 },
  width: 320,
  height: 240,
  kind: 'agent',
  profileId: null,
  runtimeKind: null,
  terminalProviderHint: null,
  labelColorOverride: null,
  status: 'exited',
  startedAt: '2026-11-09T10:00:00.000Z',
  endedAt: '2026-11-09T11:00:00.000Z',
  exitCode: 1,
  lastError: null,
  executionDirectory: null,
  expectedDirectory: null,
  agent: null,
  task: null,
  scrollback: null,
}

const workspace = {
  id: 'p1',
  name: 'p1',
  path: '/repo',
  worktreesRoot: '/repo',
  pullRequestBaseBranchOptions: [],
  spaceArchiveRecords: [],
  viewport: { x: 0, y: 0, zoom: 1 },
  isMinimapVisible: true,
  spaces: [],
  activeSpaceId: null,
  nodes: [terminalNode],
}

async function fixture(options: { failRetire?: boolean } = {}) {
  const store = createInMemoryPersistenceStore()
  await store.writeAppState({
    formatVersion: 1,
    activeWorkspaceId: 'p1',
    workspaces: [workspace],
    settings: {},
  } as never)
  const events: string[] = []
  const exitListeners = new Set<(event: { sessionId: string; exitCode: number }) => void>()
  let spawned = 0
  const ptyRuntime: Pick<ControlSurfacePtyRuntime, 'spawnSession' | 'kill'> = {
    spawnSession: async () => {
      spawned += 1
      events.push(`spawn:s${spawned}`)
      return { sessionId: `s${spawned}` }
    },
    kill: sessionId => {
      events.push(`kill:${sessionId}`)
      queueMicrotask(() => exitListeners.forEach(listener => listener({ sessionId, exitCode: 0 })))
    },
  }
  const sessions = createLiveSessions({
    getPersistenceStore: async () => store,
    onExit: listener => {
      exitListeners.add(listener)
      return () => exitListeners.delete(listener)
    },
  })
  const real = createExecutorTuiLauncher({
    ptyRuntime,
    resolveCodexExecutable: () => '/usr/bin/codex',
    liveSessionOf: nodeId => sessions.liveSessionOf(nodeId)?.sessionId ?? null,
    bindSession: sessions.bindSession,
  })
  const retired: string[] = []
  const tui: ExecutorTuiLauncher = {
    ...real,
    retire: nodeId => {
      retired.push(nodeId)
      real.retire(nodeId)
      if (options.failRetire) {
        throw new Error('retire failed')
      }
    },
  }
  const harness = await bootedHarness({ tui })
  harness.nodes.set(EXECUTOR, { nodeId: EXECUTOR, provider: 'codex', title: 'executor' })
  const nodeOf = async () => {
    const state = (await store.readAppState()) as {
      workspaces: { nodes: (typeof terminalNode)[] }[]
    }
    return state.workspaces[0].nodes[0]
  }
  const link = () =>
    harness.service.createLink(USER, { orchestratorNodeId: ORCHESTRATOR, executorNodeId: EXECUTOR })
  const settle = () => new Promise(resolve => setTimeout(resolve, 0))
  return { harness, sessions, events, retired, nodeOf, link, settle, launcher: real }
}

describe('executor TUI cycle (wave 5 D1)', () => {
  it('orch close kills the TUI of the node before the service goes away', async () => {
    const f = await fixture()
    await f.link()
    expect(f.sessions.liveSessionOf(EXECUTOR)?.sessionId).toBe('s1')
    await f.harness.service.close(orchestratorPrincipal(), { to: EXECUTOR })
    await f.settle()
    expect(f.events).toEqual(['spawn:s1', 'kill:s1'])
    expect(f.sessions.liveSessionOf(EXECUTOR)).toBeNull()
    expect(f.harness.runtimes.get(EXECUTOR)?.closes).toEqual(['link_closed'])
  })

  it('the user close and the node deletion retire the TUI as well', async () => {
    const user = await fixture()
    await user.link()
    await user.harness.service.close(USER, { to: EXECUTOR })
    expect(user.events).toContain('kill:s1')

    const deleted = await fixture()
    await deleted.link()
    deleted.harness.nodes.delete(EXECUTOR)
    await deleted.harness.service.reconcileDeletedNodes()
    expect(deleted.events).toContain('kill:s1')
  })

  it('a failed link creation retires the TUI of the node', async () => {
    const f = await fixture()
    f.harness.failNextStart.error = Object.assign(new Error('boom'), {
      code: 'executor.start_failed',
    })
    await expect(f.link()).rejects.toBeDefined()
    expect(f.retired).toEqual([EXECUTOR])
  })

  it('a failing retire does not undo the close', async () => {
    const f = await fixture({ failRetire: true })
    await f.link()
    await f.harness.service.close(orchestratorPrincipal(), { to: EXECUTOR })
    expect(await f.harness.links.findActiveByExecutor(EXECUTOR)).toBeNull()
    expect(f.harness.runtimes.get(EXECUTOR)?.closes).toEqual(['link_closed'])
  })

  it('relinking after a close leaves the node running on the new session', async () => {
    const f = await fixture()
    await f.link()
    await f.harness.service.close(orchestratorPrincipal(), { to: EXECUTOR })
    await f.settle()
    await f.link()
    await f.settle()
    expect(f.sessions.liveSessionOf(EXECUTOR)?.sessionId).toBe('s2')
    expect(await f.nodeOf()).toMatchObject({
      sessionId: 's2',
      status: 'running',
      endedAt: null,
      exitCode: null,
    })
  })

  describe('relaunch with the TUI open', () => {
    afterEach(() => vi.useRealTimers())

    it('returns without killing, and the old PTY dies after the delay', async () => {
      const f = await fixture()
      await f.link()
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      await expect(f.harness.service.relaunchExecutorTui(EXECUTOR)).resolves.toBe(true)
      expect(f.events).toEqual(['spawn:s1', 'spawn:s2'])
      expect(f.sessions.liveSessionOf(EXECUTOR)?.sessionId).toBe('s2')
      expect(await f.nodeOf()).toMatchObject({ sessionId: 's2', status: 'running' })
      await vi.advanceTimersByTimeAsync(RELAUNCH_KILL_DELAY_MS - 1)
      expect(f.events).toEqual(['spawn:s1', 'spawn:s2'])
      await vi.advanceTimersByTimeAsync(1)
      expect(f.events).toEqual(['spawn:s1', 'spawn:s2', 'kill:s1'])
      expect(f.sessions.liveSessionOf(EXECUTOR)?.sessionId).toBe('s2')
      expect(await f.nodeOf()).toMatchObject({ sessionId: 's2', status: 'running', exitCode: null })
    })

    it('a second relaunch inside the delay kills the first PTY at once and leaves no orphan', async () => {
      const f = await fixture()
      await f.link()
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      await f.harness.service.relaunchExecutorTui(EXECUTOR)
      await f.harness.service.relaunchExecutorTui(EXECUTOR)
      expect(f.events).toEqual(['spawn:s1', 'spawn:s2', 'spawn:s3', 'kill:s1'])
      await vi.advanceTimersByTimeAsync(RELAUNCH_KILL_DELAY_MS)
      expect(f.events).toEqual(['spawn:s1', 'spawn:s2', 'spawn:s3', 'kill:s1', 'kill:s2'])
      expect(f.sessions.liveSessionOf(EXECUTOR)?.sessionId).toBe('s3')
    })

    it('retire inside the delay kills both the old and the current PTY', async () => {
      const f = await fixture()
      await f.link()
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      await f.harness.service.relaunchExecutorTui(EXECUTOR)
      f.launcher.retire(EXECUTOR)
      expect(f.events.slice(2).sort()).toEqual(['kill:s1', 'kill:s2'])
      await vi.advanceTimersByTimeAsync(RELAUNCH_KILL_DELAY_MS)
      expect(f.events).toHaveLength(4)
    })

    it('dispose kills the pending PTY and the timer later does nothing', async () => {
      const f = await fixture()
      await f.link()
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      await f.harness.service.relaunchExecutorTui(EXECUTOR)
      f.launcher.dispose()
      expect(f.events).toEqual(['spawn:s1', 'spawn:s2', 'kill:s1'])
      await vi.advanceTimersByTimeAsync(RELAUNCH_KILL_DELAY_MS)
      expect(f.events).toHaveLength(3)
    })
  })
})
