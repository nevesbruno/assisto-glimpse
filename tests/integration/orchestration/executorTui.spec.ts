// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSessionGrantPtyRuntime } from '../../../src/app/main/controlSurface/sessionGrantPtyRuntime'
import { canvasSpawnIdentity } from '../../../src/app/main/controlSurface/sessionSpawnIdentityContext'
import type { ControlSurfacePtyRuntime } from '../../../src/app/main/controlSurface/handlers/sessionPtyRuntime'
import { createExecutorTuiLauncher } from '../../../src/app/main/controlSurface/orchestration/executorTuiLauncher'
import { placeExecutorNode } from '../../../src/app/main/controlSurface/orchestration/executorNodePlacement'

const TOKEN = 'tok-secret-value'
const attach = {
  url: 'ws://127.0.0.1:4555',
  tokenEnv: { name: 'OPENCOVE_EXECUTOR_REMOTE_TOKEN', value: TOKEN },
  sessionRef: 'thread-1',
  cwd: '/work/executor',
}

type SpawnInput = Parameters<ControlSurfacePtyRuntime['spawnSession']>[0]

function fixture(live: Record<string, string> = {}) {
  const spawned: SpawnInput[] = []
  const killed: string[] = []
  const bound: [string, string][] = []
  const base: ControlSurfacePtyRuntime = {
    spawnSession: async input => {
      spawned.push(input)
      return { sessionId: `s${spawned.length}` }
    },
    kill: id => {
      killed.push(id)
    },
    write: () => {},
    resize: vi.fn(),
    onData: () => () => {},
    onExit: () => () => {},
  }
  const access = createSessionGrantPtyRuntime({
    runtime: base,
    ensureAssets: async () => ({ cliShimDirectory: '/cli-shims' }),
    cliPath: '/app/cli.mjs',
    controlUrl: () => 'http://localhost:1234',
  })
  const launcher = createExecutorTuiLauncher({
    ptyRuntime: access.runtime,
    resolveCodexExecutable: () => '/usr/bin/codex',
    liveSessionOf: nodeId => live[nodeId] ?? null,
    bindSession: async (nodeId, sessionId) => {
      bound.push([nodeId, sessionId])
    },
  })
  return { spawned, killed, bound, runtime: access.runtime, launcher }
}

afterEach(() => vi.unstubAllEnvs())

describe('executor TUI launcher (I-05, A5)', () => {
  it('launches the remote TUI with the token variable and without any grant', async () => {
    const f = fixture()
    await canvasSpawnIdentity.run({ projectId: 'p', spaceId: 's', nodeId: 'exec-1' }, () =>
      f.launcher.launch({ executorNodeId: 'exec-1', attach }),
    )
    expect(f.spawned).toHaveLength(1)
    const [input] = f.spawned
    expect(input.command).toBe('/usr/bin/codex')
    expect(input.args.slice(0, 4)).toEqual(['resume', 'thread-1', '--remote', attach.url])
    expect(input.args.join(' ')).not.toContain(TOKEN)
    expect(input.cwd).toBe('/work/executor')
    expect(input.env?.OPENCOVE_EXECUTOR_REMOTE_TOKEN).toBe(TOKEN)
    expect(input.env?.OPENCOVE_CONTROL_TOKEN).toBeUndefined()
    expect(input.env?.OPENCOVE_NODE_ID).toBeUndefined()
    expect(input.env?.CODEX_HOME).toBe(process.env.CODEX_HOME)
    expect(f.bound).toEqual([['exec-1', 's1']])
  })

  it('a nested PTY inherits neither the token nor the opencode password', async () => {
    vi.stubEnv('OPENCOVE_EXECUTOR_REMOTE_TOKEN', TOKEN)
    vi.stubEnv('OPENCODE_SERVER_PASSWORD', 'pw')
    const f = fixture()
    await f.runtime.spawnSession({ cwd: '/tmp', cols: 80, rows: 24, command: 'sh', args: [] })
    await f.runtime.spawnSession({
      cwd: '/tmp',
      cols: 80,
      rows: 24,
      command: 'sh',
      args: [],
      env: { OPENCOVE_EXECUTOR_REMOTE_TOKEN: TOKEN, OPENCODE_SERVER_PASSWORD: 'pw', KEEP: '1' },
    })
    for (const input of f.spawned) {
      expect(input.env?.OPENCOVE_EXECUTOR_REMOTE_TOKEN).toBeUndefined()
      expect(input.env?.OPENCODE_SERVER_PASSWORD).toBeUndefined()
    }
    expect(f.spawned[1].env?.KEEP).toBe('1')
  })

  it('relaunch replaces the live PTY of the node and rebinds', async () => {
    const f = fixture({ 'exec-1': 'old' })
    await f.launcher.relaunch({ executorNodeId: 'exec-1', attach })
    expect(f.killed).toEqual(['old'])
    expect(f.spawned).toHaveLength(1)
    expect(f.bound).toEqual([['exec-1', 's1']])
  })
})

describe('executor node placement', () => {
  const orchestrator = { x: 0, y: 0, width: 600, height: 400 }
  const size = { width: 520, height: 360 }
  it.each([1, 2, 3, 4])('places %i executors right of the orchestrator without overlap', count => {
    const placed: { x: number; y: number; width: number; height: number }[] = []
    for (let i = 0; i < count; i += 1) {
      const position = placeExecutorNode({ orchestrator, others: [orchestrator, ...placed], size })
      expect(position.x).toBeGreaterThanOrEqual(orchestrator.x + orchestrator.width)
      placed.push({ ...position, ...size })
    }
    placed.forEach((a, i) =>
      placed.slice(i + 1).forEach(b => {
        const apart =
          a.x + a.width <= b.x ||
          b.x + b.width <= a.x ||
          a.y + a.height <= b.y ||
          b.y + b.height <= a.y
        expect(apart).toBe(true)
      }),
    )
  })
})
