/* eslint-disable no-await-in-loop -- fake clock steps are sequential. */
// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  createExecutorProcessSupervisor,
  createStartQueue,
  type ServiceExit,
  type SupervisedService,
  type SupervisorClock,
} from '../../../../../src/contexts/orchestration/infrastructure/process/ExecutorProcessSupervisor'

class FakeClock implements SupervisorClock {
  time = 0
  private sleepers: { wakeAt: number; resolve: () => void }[] = []
  readonly delays: number[] = []

  now = (): number => this.time

  sleep = (ms: number, signal: AbortSignal): Promise<void> => {
    this.delays.push(ms)
    return new Promise(resolve => {
      this.sleepers.push({ wakeAt: this.time + ms, resolve })
      signal.addEventListener('abort', () => resolve(), { once: true })
    })
  }

  async advance(ms: number): Promise<void> {
    this.time += ms
    const due = this.sleepers.filter(sleeper => sleeper.wakeAt <= this.time)
    this.sleepers = this.sleepers.filter(sleeper => sleeper.wakeAt > this.time)
    due.forEach(sleeper => sleeper.resolve())
    await flush()
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve()
  }
}

class FakeService implements SupervisedService {
  readonly exited: Promise<ServiceExit>
  closed = 0
  private die!: (exit: ServiceExit) => void

  constructor() {
    this.exited = new Promise(resolve => {
      this.die = resolve
    })
  }

  crash(): void {
    this.die({ code: 1, signal: null })
  }

  close = async (): Promise<void> => {
    this.closed += 1
    this.die({ code: null, signal: 'SIGTERM' })
  }
}

function setup() {
  const clock = new FakeClock()
  const services: FakeService[] = []
  const events: string[] = []
  const supervisor = createExecutorProcessSupervisor({
    clock,
    launch: async () => {
      const service = new FakeService()
      services.push(service)
      return service
    },
    listener: {
      onDown: () => events.push('down'),
      onRecovered: () => events.push('recovered'),
      onUnavailable: () => events.push('unavailable'),
    },
  })
  return { clock, services, events, supervisor }
}

describe('ExecutorProcessSupervisor (U-07)', () => {
  it('restarts after 1, 2 and 4 s and stops at the third restart inside 60 s', async () => {
    const { clock, services, events, supervisor } = setup()
    await supervisor.start()

    services[0].crash()
    await flush()
    expect(supervisor.state()).toBe('restarting')
    await clock.advance(999)
    expect(services).toHaveLength(1)
    await clock.advance(1)
    expect(services).toHaveLength(2)

    services[1].crash()
    await flush()
    await clock.advance(2000)
    expect(services).toHaveLength(3)

    services[2].crash()
    await flush()
    await clock.advance(4000)
    expect(services).toHaveLength(4)

    services[3].crash()
    await flush()
    expect(clock.delays).toEqual([1000, 2000, 4000])
    expect(supervisor.state()).toBe('unavailable')
    expect(services).toHaveLength(4)
    expect(events.at(-1)).toBe('unavailable')
  })

  it('forgets restarts older than the 60 s window', async () => {
    const { clock, services, supervisor } = setup()
    await supervisor.start()
    for (let round = 0; round < 6; round += 1) {
      services.at(-1)?.crash()
      await flush()
      await clock.advance(61_000)
    }
    expect(supervisor.state()).toBe('running')
    expect(services).toHaveLength(7)
    expect(clock.delays.every(delay => delay === 1000)).toBe(true)
  })

  it('does not restart after stop and closes the running service', async () => {
    const { clock, services, supervisor } = setup()
    await supervisor.start()
    await supervisor.stop()
    await clock.advance(10_000)
    expect(services).toHaveLength(1)
    expect(services[0].closed).toBe(1)
    expect(supervisor.state()).toBe('stopped')
  })

  it('counts a failed relaunch as a restart', async () => {
    const clock = new FakeClock()
    let launches = 0
    const supervisor = createExecutorProcessSupervisor({
      clock,
      launch: async () => {
        launches += 1
        if (launches > 1) {
          throw new Error('bind failed')
        }
        return new FakeService()
      },
    })
    const first = await supervisor.start()
    ;(first as FakeService).crash()
    await flush()
    await clock.advance(1000)
    await clock.advance(2000)
    await clock.advance(4000)
    expect(launches).toBe(4)
    expect(supervisor.state()).toBe('unavailable')
  })

  it('serializes starts through a shared queue (V14)', async () => {
    const queue = createStartQueue()
    const order: string[] = []
    let releaseFirst!: () => void
    const first = queue(async () => {
      order.push('first:begin')
      await new Promise<void>(resolve => {
        releaseFirst = resolve
      })
      order.push('first:end')
    })
    const second = queue(async () => {
      order.push('second:begin')
    })
    await flush()
    expect(order).toEqual(['first:begin'])
    releaseFirst()
    await Promise.all([first, second])
    expect(order).toEqual(['first:begin', 'first:end', 'second:begin'])
  })

  it('keeps the queue alive after a failed start', async () => {
    const queue = createStartQueue()
    await expect(queue(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    await expect(queue(async () => 'ok')).resolves.toBe('ok')
  })
})
