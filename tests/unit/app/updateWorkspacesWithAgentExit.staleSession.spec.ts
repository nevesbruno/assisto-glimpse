import { describe, expect, it } from 'vitest'
import { updateWorkspacesWithAgentExit } from '../../../src/app/renderer/shell/hooks/usePtyWorkspaceRuntimeSync'

const workspaces = [
  {
    id: 'w1',
    name: 'w1',
    path: '/tmp/w1',
    worktreesRoot: '/tmp/w1',
    nodes: [
      {
        id: 'executor',
        type: 'terminal',
        position: { x: 0, y: 0 },
        data: {
          kind: 'agent',
          title: 'executor',
          sessionId: 'new-session',
          status: 'running',
          startedAt: '2026-11-11T10:00:00.000Z',
          endedAt: null,
          exitCode: null,
        },
      },
    ],
  },
] as never

describe('updateWorkspacesWithAgentExit, stale sessions', () => {
  it('ignores the exit of a session that is no longer the one bound to the node', () => {
    const result = updateWorkspacesWithAgentExit({
      workspaces,
      sessionId: 'old-session',
      exitCode: 0,
      now: '2026-11-11T10:05:00.000Z',
    })
    expect(result.didChange).toBe(false)
    expect(result.nextWorkspaces).toEqual(workspaces)
  })

  it('still marks the node exited when the exiting session is the bound one', () => {
    const result = updateWorkspacesWithAgentExit({
      workspaces,
      sessionId: 'new-session',
      exitCode: 0,
      now: '2026-11-11T10:05:00.000Z',
    })
    expect(result.didChange).toBe(true)
    expect(result.nextWorkspaces[0]?.nodes[0]?.data.status).toBe('exited')
  })
})
