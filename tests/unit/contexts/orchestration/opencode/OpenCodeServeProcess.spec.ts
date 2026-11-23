// @vitest-environment node
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  startOpenCodeServeProcess,
  type OpenCodeInfoProbe,
  type OpenCodeServeChild,
  type OpenCodeServeDeps,
} from '../../../../../src/contexts/orchestration/infrastructure/opencode/OpenCodeServeProcess'
import {
  buildOpenCodeProcessEnv,
  openCodeServeArgs,
  openCodeServeEnv,
} from '../../../../../src/contexts/orchestration/infrastructure/opencode/openCodeProcessEnv'

const PASSWORD = 'worker-password-value'

class FakeChild extends EventEmitter {
  stderr = null
  constructor(readonly pid: number) {
    super()
  }
}

interface Harness {
  deps: Partial<OpenCodeServeDeps>
  children: FakeChild[]
  spawned: { command: string; args: string[]; env: Record<string, string> }[]
  kills: [number, string][]
  ports: number[]
  probeCalls: { port: number; password: string }[]
}

function harness(options: {
  probe?: (port: number, call: number) => OpenCodeInfoProbe | Promise<OpenCodeInfoProbe>
  onSpawn?: (child: FakeChild, index: number) => void
  ignoreTerm?: boolean
}): Harness {
  let time = 0
  let nextPort = 43_000
  const state: Harness = {
    children: [],
    spawned: [],
    kills: [],
    ports: [],
    probeCalls: [],
    deps: {},
  }
  state.deps = {
    portReserver: {
      reserveLoopbackPort: async () => {
        nextPort += 1
        state.ports.push(nextPort)
        return nextPort
      },
    },
    spawnChild: (command, args, spawnOptions) => {
      const child = new FakeChild(7000 + state.children.length)
      state.children.push(child)
      state.spawned.push({ command, args, env: spawnOptions.env })
      options.onSpawn?.(child, state.children.length - 1)
      return child as unknown as OpenCodeServeChild
    },
    probeInfo: async (port, password) => {
      state.probeCalls.push({ port, password })
      return options.probe?.(port, state.probeCalls.length) ?? { kind: 'ok', version: '2.3.0' }
    },
    sleep: async ms => {
      time += ms
    },
    now: () => time,
    killGroup: (pid, signal) => {
      state.kills.push([pid, signal])
      const child = state.children.find(candidate => candidate.pid === pid)
      if (signal === 'SIGKILL' || !options.ignoreTerm) {
        child?.emit('exit', null, signal)
      }
    },
    randomToken: () => PASSWORD,
  }
  return state
}

const input = {
  executablePath: '/usr/bin/opencode',
  cwd: '/work/executor',
  env: { PATH: '/bin', HOME: '/home/u' },
}

describe('openCodeProcessEnv', () => {
  it('builds the serve line on loopback with no secret in argv', () => {
    const args = openCodeServeArgs({ port: 4242 })
    expect(args).toEqual(['serve', '--hostname', '127.0.0.1', '--port', '4242'])
    expect(args.join(' ')).not.toContain(PASSWORD)
  })

  it('drops OPENCOVE_* and keeps the provider variables', () => {
    expect(
      buildOpenCodeProcessEnv(
        {
          PATH: '/bin',
          OPENCOVE_CONTROL_TOKEN: 'x',
          OPENCOVE_WORKER_URL: 'y',
          HOME: '/home/u',
          EMPTY: undefined,
        },
        { ANTHROPIC_API_KEY: 'k' },
      ),
    ).toEqual({ PATH: '/bin', HOME: '/home/u', ANTHROPIC_API_KEY: 'k' })
  })

  it('injects the password only in the child environment', () => {
    const env = openCodeServeEnv({ PATH: '/bin' }, PASSWORD)
    expect(env).toEqual({ PATH: '/bin', OPENCODE_SERVER_PASSWORD: PASSWORD })
  })
})

describe('startOpenCodeServeProcess (F3-01)', () => {
  it('spawns serve with the password in the environment and the serve line clean', async () => {
    const h = harness({})
    const handle = await startOpenCodeServeProcess(input, h.deps.portReserver!, h.deps)
    expect(h.spawned).toHaveLength(1)
    expect(h.spawned[0].command).toBe('/usr/bin/opencode')
    expect(h.spawned[0].args).toEqual([
      'serve',
      '--hostname',
      '127.0.0.1',
      '--port',
      String(handle.port),
    ])
    expect(h.spawned[0].args.join(' ')).not.toContain(PASSWORD)
    expect(h.spawned[0].env.OPENCODE_SERVER_PASSWORD).toBe(PASSWORD)
    expect(handle.password).toBe(PASSWORD)
    expect(handle.passwordSha256).toBe(createHash('sha256').update(PASSWORD).digest('hex'))
    expect(handle.url).toBe(`http://127.0.0.1:${handle.port}`)
    expect(h.probeCalls[0]).toMatchObject({ port: handle.port, password: PASSWORD })
  })

  it('probes /api/info with the Basic credential of the process', async () => {
    const h = harness({})
    const handle = await startOpenCodeServeProcess(input, h.deps.portReserver!, h.deps)
    expect(h.probeCalls.every(call => call.password === handle.password)).toBe(true)
  })

  it('keeps polling the same attempt through two 503 answers and starts on the third', async () => {
    let calls = 0
    const h = harness({
      probe: () => {
        calls += 1
        return calls <= 2 ? { kind: 'unreachable' } : { kind: 'ok', version: '2.3.0' }
      },
    })
    const handle = await startOpenCodeServeProcess(input, h.deps.portReserver!, h.deps)
    expect(h.spawned).toHaveLength(1)
    expect(h.ports).toHaveLength(1)
    expect(handle.port).toBe(h.ports[0])
    expect(h.kills).toEqual([])
    expect(calls).toBe(3)
  })

  it('fails with executor.protocol_mismatch and ends the process on HTML', async () => {
    const h = harness({ probe: () => ({ kind: 'mismatch', reason: 'html_instead_of_json' }) })
    await expect(
      startOpenCodeServeProcess(input, h.deps.portReserver!, h.deps),
    ).rejects.toMatchObject({ code: 'executor.protocol_mismatch' })
    expect(h.spawned).toHaveLength(1)
    expect(h.kills).toEqual([[h.children[0].pid, 'SIGTERM']])
  })

  it('fails with executor.start_failed on 401 of its own credential, not mismatch', async () => {
    const h = harness({ probe: () => ({ kind: 'unauthorized' }) })
    await expect(
      startOpenCodeServeProcess(input, h.deps.portReserver!, h.deps),
    ).rejects.toMatchObject({ code: 'executor.start_failed' })
    expect(h.spawned).toHaveLength(3)
  })

  it('retries on up to 3 new ports when the process leaves before readiness', async () => {
    const h = harness({
      onSpawn: (child, index) => {
        if (index < 2) {
          queueMicrotask(() => child.emit('exit', 1, null))
        }
      },
    })
    const handle = await startOpenCodeServeProcess(input, h.deps.portReserver!, h.deps)
    expect(h.ports).toHaveLength(3)
    expect(new Set(h.ports).size).toBe(3)
    expect(handle.port).toBe(h.ports[2])
  })

  it('gives each attempt 10 s of readiness and ends with start_failed', async () => {
    const h = harness({ probe: () => ({ kind: 'unreachable' }) })
    await expect(
      startOpenCodeServeProcess(input, h.deps.portReserver!, h.deps),
    ).rejects.toMatchObject({ code: 'executor.start_failed' })
    expect(h.spawned).toHaveLength(3)
    expect(h.deps.now!()).toBeGreaterThanOrEqual(30_000)
  })

  it('closes with SIGTERM on the group and escalates after the grace', async () => {
    const h = harness({ ignoreTerm: true })
    const handle = await startOpenCodeServeProcess(input, h.deps.portReserver!, h.deps)
    const before = h.deps.now!()
    await handle.close()
    expect(h.kills).toEqual([
      [handle.pid, 'SIGTERM'],
      [handle.pid, 'SIGKILL'],
    ])
    expect(h.deps.now!() - before).toBe(3000)
  })

  it('does not signal an already exited process and reports the exit', async () => {
    const h = harness({})
    const handle = await startOpenCodeServeProcess(input, h.deps.portReserver!, h.deps)
    h.children[0].emit('exit', 7, null)
    await expect(handle.exited).resolves.toEqual({ code: 7, signal: null })
    await handle.close()
    expect(h.kills).toEqual([])
  })
})
