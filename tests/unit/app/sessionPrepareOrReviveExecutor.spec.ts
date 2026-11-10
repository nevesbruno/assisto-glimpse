import { describe, expect, it, vi } from 'vitest'
import { prepareTerminalNode } from '../../../src/app/main/controlSurface/handlers/sessionPrepareOrRevivePreparation'
import type { ControlSurface } from '../../../src/app/main/controlSurface/controlSurface'
import type { ControlSurfaceContext } from '../../../src/app/main/controlSurface/types'
import type {
  NormalizedPersistedNode,
  NormalizedPersistedWorkspace,
} from '../../../src/platform/persistence/sqlite/normalize'

const ctx = { now: () => new Date('2026-11-10T00:00:00.000Z') } as ControlSurfaceContext

const node = {
  id: 'exec-1',
  sessionId: null,
  title: 'executor',
  position: { x: 0, y: 0 },
  width: 520,
  height: 720,
  kind: 'terminal',
  profileId: null,
  runtimeKind: null,
  terminalGeometry: null,
  terminalProviderHint: null,
  labelColorOverride: null,
  sidebarSortOrder: null,
  status: null,
  startedAt: null,
  endedAt: null,
  exitCode: null,
  lastError: null,
  executionDirectory: '/local/repo',
  expectedDirectory: '/local/repo',
  agent: null,
  task: null,
  scrollback: null,
} as NormalizedPersistedNode

const workspace = {
  id: 'workspace-1',
  name: 'repo',
  iconId: null,
  path: '/local/repo',
  worktreesRoot: '',
  pullRequestBaseBranchOptions: [],
  environmentVariables: {},
  spaceArchiveRecords: [],
  viewport: { x: 0, y: 0, zoom: 1 },
  isMinimapVisible: true,
  spaces: [],
  activeSpaceId: null,
  nodes: [],
} as NormalizedPersistedWorkspace

function setup(reviveExecutorTui?: (nodeId: string) => Promise<string | null>) {
  const invoked: string[] = []
  const controlSurface = {
    invoke: vi.fn(async (_ctx, request) => {
      invoked.push(request.id)
      if (request.id === 'mount.list') {
        return { ok: true, value: { projectId: 'workspace-1', mounts: [] } }
      }
      return {
        ok: true,
        value: { sessionId: 'fresh-shell', profileId: null, runtimeKind: 'posix' },
      }
    }),
  } as ControlSurface
  const prepare = () =>
    prepareTerminalNode({
      controlSurface,
      ctx,
      ptyRuntime: { write: vi.fn() } as never,
      store: { readNodeScrollback: vi.fn(async () => null) } as never,
      workspace,
      node,
      space: null,
      ...(reviveExecutorTui ? { reviveExecutorTui } : {}),
    })
  return { invoked, prepare }
}

const spawned = (invoked: string[]) => invoked.some(id => id.startsWith('pty.spawn'))

describe('session prepare/revive of a linked executor node', () => {
  it('returns the TUI session without spawning a fresh shell', async () => {
    const revive = vi.fn(async () => 'tui-session')
    const { invoked, prepare } = setup(revive)

    const prepared = await prepare()

    expect(revive).toHaveBeenCalledWith('exec-1')
    expect(prepared).toMatchObject({ recoveryState: 'restarted', sessionId: 'tui-session' })
    expect(spawned(invoked)).toBe(false)
  })

  it('keeps the normal path when there is no active link', async () => {
    const { invoked, prepare } = setup(vi.fn(async () => null))

    const prepared = await prepare()

    expect(prepared.sessionId).toBe('fresh-shell')
    expect(spawned(invoked)).toBe(true)
  })

  it('keeps the normal path without an orchestration reviver', async () => {
    const { invoked, prepare } = setup()

    const prepared = await prepare()

    expect(prepared.sessionId).toBe('fresh-shell')
    expect(spawned(invoked)).toBe(true)
  })

  it('turns a revive error into a recoverable result with no shell', async () => {
    const { invoked, prepare } = setup(vi.fn(async () => Promise.reject(new Error('boom'))))

    const prepared = await prepare()

    expect(prepared.sessionId).toBe('')
    expect(prepared.lastError).toContain('boom')
    expect(spawned(invoked)).toBe(false)
  })
})
