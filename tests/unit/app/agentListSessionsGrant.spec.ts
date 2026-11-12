// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

const listAgentSessionsMock = vi.hoisted(() => vi.fn())
vi.mock('../../../src/contexts/agent/infrastructure/cli/AgentSessionCatalog', () => ({
  listAgentSessions: listAgentSessionsMock,
}))

import { createControlSurface } from '../../../src/app/main/controlSurface/controlSurface'
import { registerAgentSessionCatalogHandlers } from '../../../src/app/main/controlSurface/handlers/agentSessionCatalogHandlers'
import { grantContext, twoProjectGrantStore } from '../../support/grantStateStore'

async function invokeAs(projectId: string | null, cwd: string, nested = true) {
  const store = await twoProjectGrantStore({ a: '/repo/a', b: nested ? '/repo/a/b' : '/repo/a-b' })
  const control = createControlSurface()
  registerAgentSessionCatalogHandlers(control, {
    approvedWorkspaces: { isPathApproved: async () => true } as never,
    readStore: async () => store,
  })
  const ctx = projectId ? grantContext(projectId) : { now: () => new Date() }
  const result = await control.invoke(ctx, {
    kind: 'query',
    id: 'agent.listSessions',
    payload: { provider: 'codex', cwd, limit: 20 },
  } as never)
  return (result as { value: { sessions: unknown[] } }).value.sessions
}

describe('agent.listSessions under a grant', () => {
  beforeEach(() => {
    listAgentSessionsMock.mockReset().mockImplementation(async p => ({
      provider: p.provider,
      cwd: p.cwd,
      sessions: [{ id: p.cwd }],
    }))
  })

  it('lists the own project and its subfolders', async () => {
    expect(await invokeAs('project-a', '/repo/a')).toHaveLength(1)
    expect(await invokeAs('project-a', '/repo/a/docs')).toHaveLength(1)
  })

  it('hides the sessions of a project nested under the grant project', async () => {
    listAgentSessionsMock.mockClear()
    expect(await invokeAs('project-a', '/repo/a/b')).toEqual([])
    expect(await invokeAs('project-a', '/repo/a/b/deep')).toEqual([])
    expect(listAgentSessionsMock).not.toHaveBeenCalled()
  })

  it('keeps the nested project readable for its own grant and for the user', async () => {
    expect(await invokeAs('project-b', '/repo/a/b')).toHaveLength(1)
    expect(await invokeAs(null, '/repo/a/b')).toHaveLength(1)
  })

  it('treats a sibling sharing a name prefix as foreign', async () => {
    expect(await invokeAs('project-a', '/repo/a-b', false)).toEqual([])
    expect(await invokeAs('project-b', '/repo/a-b', false)).toHaveLength(1)
  })
})
