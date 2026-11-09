import { describe, expect, it } from 'vitest'
import { createExecutorLink } from '../../../../../src/contexts/orchestration/domain/agentLink'
import {
  authorizeDirectInput,
  authorizeOrchestration,
  visibleLinks,
  type AuthorizationResult,
  type OrchestrationOperation,
  type OrchestrationPrincipal,
} from '../../../../../src/contexts/orchestration/domain/orchestrationAuthorization'

const now = new Date('2026-11-09T12:00:00.000Z')

const link = createExecutorLink({
  id: 'link-1',
  spaceId: 's1',
  orchestrator: { nodeId: 'orq', projectId: 'p1', provider: 'claude-code' },
  executor: { nodeId: 'exec', projectId: 'p1', provider: 'codex' },
  spawnRequestId: null,
  existingLinks: [],
  now,
})
const otherLink = createExecutorLink({
  id: 'link-2',
  spaceId: 's1',
  orchestrator: { nodeId: 'orq2', projectId: 'p1', provider: 'claude-code' },
  executor: { nodeId: 'exec2', projectId: 'p1', provider: 'codex' },
  spawnRequestId: null,
  existingLinks: [],
  now,
})
const links = [link, otherLink]

function agent(nodeId: string, provider: string, overrides = {}): OrchestrationPrincipal {
  return {
    kind: 'agent',
    nodeId,
    projectId: 'p1',
    spaceId: 's1',
    sessionId: 'sess',
    provider,
    grantActive: true,
    ...overrides,
  }
}

const user: OrchestrationPrincipal = { kind: 'user' }
const linkedOrchestrator = agent('orq', 'claude-code')
const unlinkedOrchestrator = agent('orq3', 'claude-code')
const executor = agent('exec', 'codex')
const commonWindow = agent('win', 'terminal')

const allow: AuthorizationResult = { allowed: true }
const forbidden: AuthorizationResult = { allowed: false, code: 'orch.forbidden' }
const notLinked: AuthorizationResult = { allowed: false, code: 'orch.not_linked' }

function run(
  principal: OrchestrationPrincipal,
  operation: OrchestrationOperation,
  targetExecutorNodeId: string | null = null,
): AuthorizationResult {
  return authorizeOrchestration({ principal, operation, targetExecutorNodeId, links })
}

describe('orchestration authorization (U-09)', () => {
  describe('matrix by principal', () => {
    const targeted: readonly OrchestrationOperation[] = [
      'orch.dispatch',
      'orch.cancel',
      'orch.interrupt',
      'orch.close',
    ]

    it('user passes every operation', () => {
      const operations: readonly OrchestrationOperation[] = [
        'orch.spawn',
        ...targeted,
        'orch.status',
        'orch.link.list',
        'orch.link.create',
        'orch.link.close',
        'orch.link.extend',
        'orch.approval.respond',
        'orch.hooks.approve',
      ]
      for (const operation of operations) {
        expect(run(user, operation, 'exec2'), operation).toEqual(allow)
      }
    })

    it('linked orchestrator reaches only its own executors', () => {
      for (const operation of targeted) {
        expect(run(linkedOrchestrator, operation, 'exec'), operation).toEqual(allow)
        expect(run(linkedOrchestrator, operation, 'exec2'), operation).toEqual(notLinked)
      }
      expect(run(linkedOrchestrator, 'orch.spawn')).toEqual(allow)
      expect(run(linkedOrchestrator, 'orch.status')).toEqual(allow)
      expect(run(linkedOrchestrator, 'orch.status', 'exec')).toEqual(allow)
      expect(run(linkedOrchestrator, 'orch.status', 'exec2')).toEqual(notLinked)
      expect(run(linkedOrchestrator, 'orch.link.list')).toEqual(allow)
    })

    it('orchestrator without a link can spawn and sees nothing else', () => {
      expect(run(unlinkedOrchestrator, 'orch.spawn')).toEqual(allow)
      for (const operation of targeted) {
        expect(run(unlinkedOrchestrator, operation, 'exec'), operation).toEqual(notLinked)
      }
      expect(run(unlinkedOrchestrator, 'orch.status')).toEqual(allow)
      expect(run(unlinkedOrchestrator, 'orch.link.list')).toEqual(allow)
    })

    it('executor gets nothing (A5)', () => {
      for (const operation of [
        'orch.spawn',
        ...targeted,
        'orch.status',
        'orch.link.list',
      ] as const) {
        expect(run(executor, operation, 'exec'), operation).toEqual(forbidden)
      }
    })

    it('common window only reads an empty list and cannot spawn', () => {
      expect(run(commonWindow, 'orch.spawn')).toEqual(forbidden)
      for (const operation of targeted) {
        expect(run(commonWindow, operation, 'exec'), operation).toEqual(forbidden)
      }
      expect(run(commonWindow, 'orch.status')).toEqual(allow)
      expect(run(commonWindow, 'orch.link.list')).toEqual(allow)
    })
  })

  it('A2: inactive grant is refused for any agent', () => {
    expect(
      run(agent('orq', 'claude-code', { grantActive: false }), 'orch.dispatch', 'exec'),
    ).toEqual(forbidden)
  })

  it('A3: link in another project does not count', () => {
    expect(run(agent('orq', 'claude-code', { projectId: 'p2' }), 'orch.dispatch', 'exec')).toEqual(
      notLinked,
    )
  })

  it('A3: closed link does not count', () => {
    const closed = [{ ...link, state: 'closed' as const }]
    expect(
      authorizeOrchestration({
        principal: linkedOrchestrator,
        operation: 'orch.dispatch',
        targetExecutorNodeId: 'exec',
        links: closed,
      }),
    ).toEqual(notLinked)
  })

  it('A4: not_linked is identical for a missing node and for someone else node', () => {
    expect(run(linkedOrchestrator, 'orch.dispatch', 'ghost')).toEqual(
      run(linkedOrchestrator, 'orch.dispatch', 'exec2'),
    )
    expect(run(linkedOrchestrator, 'orch.dispatch', 'ghost')).toEqual(notLinked)
  })

  it('A6: admin operations are out of reach of every agent', () => {
    for (const operation of [
      'orch.link.create',
      'orch.link.close',
      'orch.link.extend',
      'orch.approval.respond',
      'orch.hooks.approve',
    ] as const) {
      for (const principal of [linkedOrchestrator, unlinkedOrchestrator, executor, commonWindow]) {
        expect(run(principal, operation, 'exec'), `${operation} ${principal.kind}`).toEqual(
          forbidden,
        )
      }
    }
  })

  it('visible links: user all, orchestrator its own, others empty', () => {
    expect(visibleLinks(user, links)).toEqual(links)
    expect(visibleLinks(linkedOrchestrator, links)).toEqual([link])
    expect(visibleLinks(unlinkedOrchestrator, links)).toEqual([])
    expect(visibleLinks(commonWindow, links)).toEqual([])
    expect(visibleLinks(executor, links)).toEqual([])
    expect(visibleLinks(agent('orq', 'claude-code', { projectId: 'p2' }), links)).toEqual([])
  })

  describe('A7: direct input to a linked executor', () => {
    const shortcuts = ['agent.prompt', 'session.writeNode'] as const

    it.each(shortcuts)(
      '%s from an agent grant against a linked executor is orch.use_dispatch',
      operation => {
        for (const principal of [linkedOrchestrator, unlinkedOrchestrator, commonWindow]) {
          expect(
            authorizeDirectInput({ principal, operation, targetNodeId: 'exec', links }),
          ).toEqual({ allowed: false, code: 'orch.use_dispatch' })
        }
      },
    )

    it.each(shortcuts)('%s is free for the user and for unlinked targets', operation => {
      expect(
        authorizeDirectInput({ principal: user, operation, targetNodeId: 'exec', links }),
      ).toEqual(allow)
      expect(
        authorizeDirectInput({
          principal: linkedOrchestrator,
          operation,
          targetNodeId: 'free',
          links,
        }),
      ).toEqual(allow)
    })

    it.each(shortcuts)('%s ignores a closed link', operation => {
      expect(
        authorizeDirectInput({
          principal: linkedOrchestrator,
          operation,
          targetNodeId: 'exec',
          links: [{ ...link, state: 'closed' }],
        }),
      ).toEqual(allow)
    })
  })
})
