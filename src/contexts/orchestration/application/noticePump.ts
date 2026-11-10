import { composeNotice } from '../domain/noticeComposer'
import type {
  Clock,
  IdGenerator,
  NoticeOutboxRepository,
  OrchestratorDeliveryPort,
  OrchestratorReadinessPort,
} from './ports'

export const NOTICE_WINDOW_MS = 2_000

export interface NoticePumpDeps {
  readonly notices: Pick<NoticeOutboxRepository, 'listPending' | 'settleBatch'>
  readonly delivery: OrchestratorDeliveryPort
  readonly readiness: OrchestratorReadinessPort
  readonly clock: Clock
  readonly ids: Pick<IdGenerator, 'uuid'>
  /** Returns the canceller, like the registry scheduler. */
  readonly schedule: (callback: () => void, delayMs: number) => () => void
  readonly windowMs?: number
  readonly onError?: (error: unknown) => void
}

export interface NoticePump {
  /** Something may be pending for the orchestrator: opens the 2 s window unless one is open. */
  poke: (orchestratorNodeId: string) => void
  dispose: () => void
}

interface Lane {
  cancelWindow: (() => void) | null
  cancelWatch: (() => void) | null
  flushing: boolean
  again: boolean
}

/** Delivers the outbox in one batch per idle moment of the orchestrator, never by polling. */
export function createNoticePump(deps: NoticePumpDeps): NoticePump {
  const lanes = new Map<string, Lane>()
  const windowMs = deps.windowMs ?? NOTICE_WINDOW_MS

  const laneOf = (orchestratorNodeId: string): Lane => {
    let lane = lanes.get(orchestratorNodeId)
    if (!lane) {
      lane = { cancelWindow: null, cancelWatch: null, flushing: false, again: false }
      lanes.set(orchestratorNodeId, lane)
    }
    return lane
  }

  const run = (orchestratorNodeId: string): void => {
    flush(orchestratorNodeId).catch(error => deps.onError?.(error))
  }

  function watchIdle(orchestratorNodeId: string, lane: Lane): void {
    lane.cancelWatch = deps.readiness.watchReadiness(orchestratorNodeId, readiness => {
      if (readiness.idle) {
        lane.cancelWatch?.()
        lane.cancelWatch = null
        run(orchestratorNodeId)
      }
    })
  }

  /** Subscribes first and reads once more, so a change between the two is not lost. */
  async function waitForIdle(orchestratorNodeId: string, lane: Lane): Promise<void> {
    watchIdle(orchestratorNodeId, lane)
    if ((await deps.readiness.readReadiness(orchestratorNodeId)).idle) {
      lane.cancelWatch?.()
      lane.cancelWatch = null
      run(orchestratorNodeId)
    }
  }

  async function flush(orchestratorNodeId: string): Promise<void> {
    const lane = laneOf(orchestratorNodeId)
    lane.flushing = true
    try {
      if (!(await deps.readiness.readReadiness(orchestratorNodeId)).idle) {
        await waitForIdle(orchestratorNodeId, lane)
        return
      }
      const pending = await deps.notices.listPending(orchestratorNodeId)
      if (pending.length > 0) {
        await deliverBatch(orchestratorNodeId, lane, pending)
      }
    } finally {
      lane.flushing = false
      if (lane.again && !lane.cancelWatch) {
        lane.again = false
        open(orchestratorNodeId, lane)
      }
    }
  }

  async function deliverBatch(
    orchestratorNodeId: string,
    lane: Lane,
    pending: Awaited<ReturnType<NoticeOutboxRepository['listPending']>>,
  ): Promise<void> {
    const text = composeNotice(pending.map(notice => notice.entry))
    if (!text) {
      return
    }
    const deliveryId = deps.ids.uuid()
    const outcome = await deps.delivery
      .deliver({ orchestratorNodeId, deliveryId, text })
      .catch(() => 'uncertain' as const)
    if (outcome === 'refused_busy') {
      watchIdle(orchestratorNodeId, lane)
      return
    }
    await deps.notices.settleBatch(
      pending.map(notice => notice.id),
      deliveryId,
      outcome,
      deps.clock.now(),
    )
  }

  function open(orchestratorNodeId: string, lane: Lane): void {
    if (lane.cancelWindow) {
      return
    }
    lane.cancelWindow = deps.schedule(() => {
      lane.cancelWindow = null
      run(orchestratorNodeId)
    }, windowMs)
  }

  return {
    poke(orchestratorNodeId) {
      const lane = laneOf(orchestratorNodeId)
      if (lane.flushing) {
        lane.again = true
      } else if (!lane.cancelWatch) {
        open(orchestratorNodeId, lane)
      }
    },
    dispose() {
      for (const lane of lanes.values()) {
        lane.cancelWindow?.()
        lane.cancelWatch?.()
      }
      lanes.clear()
    },
  }
}
