// @vitest-environment node
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  startCodexAppServer,
  type AppServerChild,
  type CodexAppServerDeps,
} from '../../../../../src/contexts/orchestration/infrastructure/codex/CodexAppServerProcess'
import {
  buildCodexAppServerArgs,
  buildCodexProcessEnv,
} from '../../../../../src/contexts/orchestration/infrastructure/codex/codexProcessEnv'

const TOKEN = 'secret-token-value'
const HASH = createHash('sha256').update(TOKEN).digest('hex')

class FakeChild extends EventEmitter {
  stderr = null
  constructor(readonly pid: number) {
    super()
  }
}

interface Harness {
  deps: Partial<CodexAppServerDeps>
  children: FakeChild[]
  spawned: { command: string; args: string[]; env: Record<string, string> }[]
  kills: [number, string][]
  ports: number[]
  setClock: (ms: number) => void
}

function harness(options: {
  readyOn?: (port: number, index: number) => boolean
  onSpawn?: (child: FakeChild, index: number) => void
  ignoreTerm?: boolean
}): Harness {
  let time = 0
  let nextPort = 41000
  const state: Harness = {
    children: [],
    spawned: [],
    kills: [],
    ports: [],
    setClock: ms => {
      time = ms
    },
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
      const child = new FakeChild(5000 + state.children.length)
      state.children.push(child)
      state.spawned.push({ command, args, env: spawnOptions.env })
      options.onSpawn?.(child, state.children.length - 1)
      return child as unknown as AppServerChild
    },
    checkReady: async port => options.readyOn?.(port, state.children.length - 1) ?? true,
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
    randomToken: () => TOKEN,
  }
  return state
}

const input = {
  executablePath: '/usr/bin/codex',
  cwd: '/work/executor',
  env: { PATH: '/bin' },
  hookTrust: [],
}

describe('codexProcessEnv', () => {
  it('builds the app-server line with the hash, inline trust tables and no token', () => {
    const args = buildCodexAppServerArgs({
      port: 4242,
      tokenSha256: HASH,
      cwd: '/work/my "dir"',
      hookTrust: [{ key: 'user:hooks.json:pre_tool_use:0:0', trustedHash: 'sha256:abc' }],
    })
    expect(args).toEqual([
      'app-server',
      '--listen',
      'ws://127.0.0.1:4242',
      '--ws-auth',
      'capability-token',
      '--ws-token-sha256',
      HASH,
      '-c',
      'projects={"/work/my \\"dir\\""={trust_level="trusted"}}',
      '-c',
      'hooks.state={"user:hooks.json:pre_tool_use:0:0"={trusted_hash="sha256:abc"}}',
    ])
    expect(args.join(' ')).not.toContain(TOKEN)
  })

  it('omits the hooks table when there is nothing approved', () => {
    const args = buildCodexAppServerArgs({ port: 1, tokenSha256: HASH, cwd: '/w', hookTrust: [] })
    expect(args.some(arg => arg.startsWith('hooks.state'))).toBe(false)
  })

  it('drops OPENCOVE_* and keeps the provider variables', () => {
    const env = buildCodexProcessEnv(
      {
        PATH: '/bin',
        OPENCOVE_TOKEN: 'x',
        OPENCOVE_WORKER_URL: 'y',
        CODEX_HOME: '/h',
        EMPTY: undefined,
      },
      { OPENAI_API_KEY: 'k' },
    )
    expect(env).toEqual({ PATH: '/bin', CODEX_HOME: '/h', OPENAI_API_KEY: 'k' })
  })
})

describe('startCodexAppServer (U-07)', () => {
  it('spawns with the hash on the line, returns the token only in memory', async () => {
    const h = harness({})
    const handle = await startCodexAppServer(input, h.deps.portReserver!, h.deps)
    expect(h.spawned).toHaveLength(1)
    expect(h.spawned[0].args.join(' ')).toContain(HASH)
    expect(h.spawned[0].args.join(' ')).not.toContain(TOKEN)
    expect(h.spawned[0].args).toContain(`ws://127.0.0.1:${handle.port}`)
    expect(handle.token).toBe(TOKEN)
    expect(handle.url).toBe(`ws://127.0.0.1:${handle.port}`)
  })

  it('retries on up to 3 new ports when the bind fails', async () => {
    const h = harness({
      onSpawn: (child, index) => {
        if (index < 2) {
          queueMicrotask(() => child.emit('exit', 1, null))
        }
      },
    })
    const handle = await startCodexAppServer(input, h.deps.portReserver!, h.deps)
    expect(h.ports).toHaveLength(3)
    expect(new Set(h.ports).size).toBe(3)
    expect(handle.port).toBe(h.ports[2])
  })

  it('fails with executor.start_failed after 3 attempts', async () => {
    const h = harness({ onSpawn: child => queueMicrotask(() => child.emit('exit', 1, null)) })
    await expect(startCodexAppServer(input, h.deps.portReserver!, h.deps)).rejects.toMatchObject({
      code: 'executor.start_failed',
    })
    expect(h.spawned).toHaveLength(3)
  })

  it('gives each attempt 10 s of readiness', async () => {
    const h = harness({ readyOn: () => false })
    await expect(startCodexAppServer(input, h.deps.portReserver!, h.deps)).rejects.toMatchObject({
      code: 'executor.start_failed',
    })
    expect(h.spawned).toHaveLength(3)
    expect(h.deps.now!()).toBeGreaterThanOrEqual(30_000)
  })

  it('succeeds when /readyz turns 200 before the deadline', async () => {
    let polls = 0
    const h = harness({ readyOn: () => ++polls > 5 })
    await expect(startCodexAppServer(input, h.deps.portReserver!, h.deps)).resolves.toBeDefined()
    expect(h.spawned).toHaveLength(1)
  })

  it('closes with SIGTERM on the group when the process leaves', async () => {
    const h = harness({})
    const handle = await startCodexAppServer(input, h.deps.portReserver!, h.deps)
    await handle.close()
    expect(h.kills).toEqual([[handle.pid, 'SIGTERM']])
  })

  it('escalates to SIGKILL on the group after the 3 s grace', async () => {
    const h = harness({ ignoreTerm: true })
    const handle = await startCodexAppServer(input, h.deps.portReserver!, h.deps)
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
    const handle = await startCodexAppServer(input, h.deps.portReserver!, h.deps)
    h.children[0].emit('exit', 7, null)
    await expect(handle.exited).resolves.toEqual({ code: 7, signal: null })
    await handle.close()
    expect(h.kills).toEqual([])
  })
})
