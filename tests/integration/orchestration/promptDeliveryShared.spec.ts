// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOrchestratorDelivery } from '../../../src/app/main/controlSurface/orchestration/orchestratorDelivery'
import { createControlSurface } from '../../../src/app/main/controlSurface/controlSurface'
import {
  createAgentPromptDelivery,
  registerAgentPromptHandlers,
} from '../../../src/app/main/controlSurface/handlers/agentPromptHandlers'
import {
  lazyOrchestration,
  type ComposedOrchestration,
  type LazyOrchestrationInput,
} from '../../../src/app/main/controlSurface/orchestration/composeOrchestration'
import { promptDeliveryRuntimeFixture } from '../../support/promptDeliveryRuntimeFixture'
import type { ControlSurfaceContext } from '../../../src/app/main/controlSurface/types'
import { AgentProviderRegistry } from '../../../src/contexts/agent/application/services/AgentProviderRegistry'
import { createBuiltinAgentProviderContributions } from '../../../src/contexts/agent/infrastructure/providers/catalog/BuiltinAgentProviderCatalog'

const ctx = { now: () => new Date(), capabilities: {} } as ControlSurfaceContext
const NODE = 'n'

type ComposeInput = Parameters<NonNullable<Parameters<typeof lazyOrchestration>[1]>>[0]

function fixture() {
  const base = promptDeliveryRuntimeFixture()
  const { hub, write } = base
  const providers = new AgentProviderRegistry(createBuiltinAgentProviderContributions())
  const delivery = createAgentPromptDelivery(hub, providers)
  const surface = createControlSurface()
  registerAgentPromptHandlers(surface, hub, delivery, async () => undefined)
  let composeInput: ComposeInput | null = null
  const lazy = lazyOrchestration(
    {
      options: { dbPath: ':memory:' },
      hub,
      delivery,
      publish: () => undefined,
    } as unknown as LazyOrchestrationInput,
    input => {
      composeInput = input
      return {} as ComposedOrchestration
    },
  )
  lazy.get()
  const notice = () =>
    composeInput!.events.delivery.deliver({
      nodeId: NODE,
      text: 'aviso',
      deliveryId: randomUUID(),
      whenBusy: 'refuse',
      timeoutMs: 15000,
    })
  const prompt = () =>
    surface.invoke(ctx, {
      kind: 'command',
      id: 'agent.prompt',
      payload: { nodeId: NODE, text: 'do it' },
    })
  return { base, hub, delivery, composeInput: () => composeInput!, notice, prompt, write }
}

describe('F2-14 4d single PromptDeliveryService per Worker', () => {
  let toDispose: (() => void) | null = null
  afterEach(() => toDispose?.())

  it('hands the same instance to the agent operations and to the orchestration composition', () => {
    const f = fixture()
    toDispose = f.base.dispose
    expect(f.composeInput().events.delivery).toBe(f.delivery)
  })

  it('a notice respects the reservation of an agent.prompt on the orchestrator PTY', async () => {
    const f = fixture()
    toDispose = f.base.dispose
    const pendingPrompt = f.prompt()
    await vi.waitFor(() => expect(f.write).toHaveBeenCalled())
    const writesBefore = f.write.mock.calls.length
    await expect(f.notice()).rejects.toMatchObject({
      code: 'agent.delivery_unsettled',
      details: { reason: 'delivery_in_progress' },
    })
    expect(f.write.mock.calls.length).toBe(writesBefore)
    void pendingPrompt
  })

  it('the real orchestrator delivery maps a notice colliding with an agent.prompt to refused_busy', async () => {
    const f = fixture()
    toDispose = f.base.dispose
    const pendingPrompt = f.prompt()
    await vi.waitFor(() => expect(f.write).toHaveBeenCalled())
    const orchestratorDelivery = createOrchestratorDelivery({
      service: f.delivery,
      timeoutMs: 15000,
    })
    await expect(
      orchestratorDelivery.deliver({
        orchestratorNodeId: NODE,
        deliveryId: randomUUID(),
        text: 'aviso',
      }),
    ).resolves.toBe('refused_busy')
    void pendingPrompt
  })

  it('an agent.prompt is refused while a notice holds the reservation', async () => {
    const f = fixture()
    toDispose = f.base.dispose
    const pendingNotice = f.notice()
    pendingNotice.catch(() => undefined)
    await vi.waitFor(() => expect(f.write).toHaveBeenCalled())
    await expect(f.prompt()).resolves.toMatchObject({
      ok: false,
      error: { code: 'agent.busy', details: { reason: 'delivery_in_progress' } },
    })
  })
})
