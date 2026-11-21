// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  bootedHarness,
  USER,
  type Harness,
} from '../../unit/contexts/orchestration/application/fakes'

const ORCHESTRATOR = 'orq'
const EXECUTOR = 'exec-resume'
const SESSION_REF = 't-1'

async function resumeHarness() {
  const order: string[] = []
  const relaunches: string[] = []
  let harness!: Harness
  harness = await bootedHarness({
    tui: {
      launch: async input => {
        order.push(`launch:${input.executorNodeId}:${harness.runtimes.has(input.executorNodeId)}`)
      },
      relaunch: async input => {
        order.push(`relaunch:${input.executorNodeId}:${harness.runtimes.has(input.executorNodeId)}`)
        relaunches.push(input.executorNodeId)
      },
      retire: () => undefined,
    },
  })
  harness.nodes.set(EXECUTOR, {
    nodeId: EXECUTOR,
    provider: 'codex',
    title: 'resumed',
    sessionRef: SESSION_REF,
  })
  return { harness, order, relaunches }
}

describe('orch.link.create with a conversation (A-07)', () => {
  it('carries the node session into the link, starts from it and relaunches the TUI after the start', async () => {
    const { harness, order, relaunches } = await resumeHarness()
    const result = await harness.service.createLink(USER, {
      orchestratorNodeId: ORCHESTRATOR,
      executorNodeId: EXECUTOR,
    })
    await harness.service.whenIdle()

    const link = harness.links.rows.get(result.linkId)
    expect(link?.executorSessionRef).toBe(SESSION_REF)
    const runtime = harness.runtimes.get(EXECUTOR)
    expect(runtime?.spec.sessionRef).toBe(SESSION_REF)
    expect(runtime?.resumeRefs).toEqual([SESSION_REF])
    expect(harness.starts.at(-1)).toMatchObject({
      executorNodeId: EXECUTOR,
      sessionRef: SESSION_REF,
    })
    expect(relaunches).toEqual([EXECUTOR])
    expect(order).toEqual([`relaunch:${EXECUTOR}:true`])
  })

  it('leaves the link without a conversation when the node knows none', async () => {
    const { harness } = await resumeHarness()
    harness.nodes.set(EXECUTOR, { nodeId: EXECUTOR, provider: 'codex', title: 'fresh' })
    const result = await harness.service.createLink(USER, {
      orchestratorNodeId: ORCHESTRATOR,
      executorNodeId: EXECUTOR,
    })
    await harness.service.whenIdle()
    expect(harness.runtimes.get(EXECUTOR)?.resumeRefs).toEqual([null])
    expect(harness.links.rows.get(result.linkId)?.executorSessionRef).toBe(`session-of-${EXECUTOR}`)
  })
})
