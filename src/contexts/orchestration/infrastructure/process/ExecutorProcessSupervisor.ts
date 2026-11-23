export interface ServiceExit {
  readonly code: number | null
  readonly signal: string | null
}

export interface SupervisedService {
  readonly exited: Promise<ServiceExit>
  close: () => Promise<void>
}

export interface SupervisorClock {
  now: () => number
  sleep: (ms: number, signal: AbortSignal) => Promise<void>
}

export type SupervisorState = 'idle' | 'running' | 'restarting' | 'unavailable' | 'stopped'

export interface SupervisorListener<T extends SupervisedService> {
  onDown?: (exit: ServiceExit | null) => void
  onRecovered?: (service: T) => void
  onUnavailable?: () => void
}

export interface ExecutorProcessSupervisor<T extends SupervisedService> {
  /** Starts the service. A failure here is the caller's: no restart loop for the first start. */
  start: () => Promise<T>
  stop: () => Promise<void>
  state: () => SupervisorState
  current: () => T | null
}

export const RESTART_BACKOFF_MS: readonly number[] = [1000, 2000, 4000]
export const RESTART_WINDOW_MS = 60_000

export type StartQueue = <R>(task: () => Promise<R>) => Promise<R>

/** Serializes service starts (V14: simultaneous first start over an empty CODEX_HOME fails). */
export function createStartQueue(): StartQueue {
  let tail: Promise<unknown> = Promise.resolve()
  return task => {
    const run = tail.then(task, task)
    tail = run.catch(() => undefined)
    return run
  }
}

export const realSupervisorClock: SupervisorClock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>(resolve => {
      const timer = setTimeout(resolve, ms)
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer)
          resolve()
        },
        { once: true },
      )
    }),
}

export interface ExecutorProcessSupervisorOptions<T extends SupervisedService> {
  launch: () => Promise<T>
  clock?: SupervisorClock
  startQueue?: StartQueue
  listener?: SupervisorListener<T>
}

export function createExecutorProcessSupervisor<T extends SupervisedService>(
  options: ExecutorProcessSupervisorOptions<T>,
): ExecutorProcessSupervisor<T> {
  const clock = options.clock ?? realSupervisorClock
  const queue: StartQueue = options.startQueue ?? (task => task())
  const listener = options.listener ?? {}
  const abort = new AbortController()
  let state: SupervisorState = 'idle'
  let service: T | null = null
  let restartTimes: number[] = []

  const launchQueued = (): Promise<T> => queue(options.launch)

  function watch(running: T): void {
    service = running
    state = 'running'
    void running.exited.then(exit => handleExit(running, exit))
  }

  async function handleExit(exited: T, exit: ServiceExit | null): Promise<void> {
    if (state === 'stopped' || service !== exited) {
      return
    }
    service = null
    listener.onDown?.(exit)
    await restart()
  }

  async function restart(): Promise<void> {
    const now = clock.now()
    restartTimes = restartTimes.filter(time => now - time < RESTART_WINDOW_MS)
    if (restartTimes.length >= RESTART_BACKOFF_MS.length) {
      state = 'unavailable'
      listener.onUnavailable?.()
      return
    }
    const delay = RESTART_BACKOFF_MS[restartTimes.length]
    restartTimes.push(now)
    state = 'restarting'
    await clock.sleep(delay, abort.signal)
    if (abort.signal.aborted) {
      return
    }
    let launched: T
    try {
      launched = await launchQueued()
    } catch {
      await restart()
      return
    }
    if (abort.signal.aborted) {
      await launched.close()
      return
    }
    watch(launched)
    listener.onRecovered?.(launched)
  }

  return {
    async start() {
      try {
        const launched = await launchQueued()
        watch(launched)
        return launched
      } catch (error) {
        state = 'unavailable'
        throw error
      }
    },
    async stop() {
      state = 'stopped'
      abort.abort()
      const running = service
      service = null
      await running?.close()
    },
    state: () => state,
    current: () => service,
  }
}
