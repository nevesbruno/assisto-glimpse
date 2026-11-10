import { describe, expect, it, vi } from 'vitest'
import { createOrchestratorDelivery } from '../../../src/app/main/controlSurface/orchestration/orchestratorDelivery'
import { createAppError } from '../../../src/shared/errors/appError'

const INPUT = { orchestratorNodeId: 'orq', deliveryId: 'batch-1', text: 'aviso' }

function setup(deliver: (request: unknown) => Promise<unknown>) {
  const service = { deliver: vi.fn(deliver) }
  const delivery = createOrchestratorDelivery({ service: service as never, timeoutMs: 15_000 })
  return { service, delivery }
}

const refusal = (
  code: 'agent.busy' | 'agent.blocked' | 'agent.delivery_unsettled',
  paste: boolean,
) => createAppError(code, { details: { pasteDispatchAttempted: paste } })

describe('orchestrator delivery (U-06)', () => {
  it('delivers with whenBusy refuse, the batch delivery id and the node', async () => {
    const { service, delivery } = setup(async () => ({ phase: 'submission_observed' }))
    await expect(delivery.deliver(INPUT)).resolves.toBe('delivered')
    expect(service.deliver).toHaveBeenCalledWith({
      nodeId: 'orq',
      text: 'aviso',
      deliveryId: 'batch-1',
      whenBusy: 'refuse',
      timeoutMs: 15_000,
    })
  })

  it.each(['agent.busy', 'agent.blocked'] as const)(
    'maps %s before any paste to refused_busy',
    async code => {
      const { delivery } = setup(async () => {
        throw refusal(code, false)
      })
      await expect(delivery.deliver(INPUT)).resolves.toBe('refused_busy')
    },
  )

  it('maps a refusal after a paste attempt to uncertain, never to a resend', async () => {
    const { delivery } = setup(async () => {
      throw refusal('agent.busy', true)
    })
    await expect(delivery.deliver(INPUT)).resolves.toBe('uncertain')
  })

  it('maps an unsettled delivery and an unknown failure to uncertain', async () => {
    const unsettled = setup(async () => {
      throw refusal('agent.delivery_unsettled', false)
    })
    await expect(unsettled.delivery.deliver(INPUT)).resolves.toBe('uncertain')
    const unknown = setup(async () => {
      throw new Error('boom')
    })
    await expect(unknown.delivery.deliver(INPUT)).resolves.toBe('uncertain')
  })

  it('reports an open delivery for the node only while it runs', async () => {
    let release: () => void = () => undefined
    const { delivery } = setup(() => new Promise(resolve => (release = () => resolve({}))))
    const pending = delivery.deliver(INPUT)
    expect(delivery.inFlight('orq')).toBe(true)
    expect(delivery.inFlight('other')).toBe(false)
    release()
    await pending
    expect(delivery.inFlight('orq')).toBe(false)
  })
})
