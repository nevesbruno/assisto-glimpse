// @vitest-environment node
/* oxlint-disable no-await-in-loop -- the backoff rounds and the real-service waits are measured in order */
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startCodexAppServer } from '../../../src/contexts/orchestration/infrastructure/codex/CodexAppServerProcess'
import { CodexJsonRpcClient } from '../../../src/contexts/orchestration/infrastructure/codex/CodexJsonRpcClient'
import { createCodexExecutorRuntimeFactory } from '../../../src/contexts/orchestration/infrastructure/codex/CodexExecutorRuntimeFactory'
import type { ExecutorRuntimeEvent } from '../../../src/contexts/orchestration/application/ports/executorRuntime'
import { reserveLoopbackPort } from '../../../src/app/main/controlSurface/handlers/sessionLaunchSupport'
import {
  AS_ORCHESTRATOR,
  dispatchId,
  EXECUTOR_NODE,
  createRig,
  settle,
  type Rig,
} from './phase2Rig'
import { configureNewClients, killService, startLinkedCodexWorker } from './codexServiceRig'

const ID = dispatchId(1)

let rig: Rig
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-11T12:00:00.000Z'))
  rig = createRig()
})
afterEach(() => {
  vi.useRealTimers()
  rig.dispose()
})

const noticeKinds = () => rig.notices().map(notice => notice.kind)

describe('I-03 service death (real runtime and supervisor over a fake process)', () => {
  it('idle executor: restarts after 1000 ms, resumes the thread and sends one executor_down notice', async () => {
    const { worker, env } = await startLinkedCodexWorker(rig)
    expect(worker.composed.service.healthOf(EXECUTOR_NODE)).toBe('ready')
    expect(env.clients).toHaveLength(1)

    await killService(env, 999)
    expect(env.clients).toHaveLength(1)
    await settle(1)
    expect(env.clients).toHaveLength(2)
    expect(env.client().methods()).toContain('thread/resume')
    await settle(2000)

    expect(worker.composed.service.healthOf(EXECUTOR_NODE)).toBe('ready')
    expect(noticeKinds()).toEqual(['executor_down'])
    expect(rig.linkRow()?.state).toBe('active')
  })

  it('backs off 1, 2 and 4 seconds between consecutive deaths', async () => {
    const { env } = await startLinkedCodexWorker(rig)
    for (const [round, delay] of [1000, 2000, 4000].entries()) {
      const before = env.clients.length
      expect(before).toBe(round + 1)
      await killService(env, delay - 1)
      expect(env.clients).toHaveLength(before)
      await settle(1)
      expect(env.clients).toHaveLength(before + 1)
    }
  })

  it('a socket that is only reconnecting is no death; a closed one closes the process', async () => {
    const { env, worker } = await startLinkedCodexWorker(rig)
    const states = env.client().stateListeners
    states.forEach(listener => listener('reconnecting'))
    states.forEach(listener => listener('connected'))
    await settle(5000)
    expect(env.processes[0].close).not.toHaveBeenCalled()
    expect(env.clients).toHaveLength(1)
    expect(noticeKinds()).toEqual([])

    states.forEach(listener => listener('closed'))
    expect(env.processes[0].close).toHaveBeenCalledTimes(1)
    expect(worker.composed.service.healthOf(EXECUTOR_NODE)).toBe('ready')
  })

  it('four deaths in 60 s with an uncertain dispatch: unavailable, failed(executor_down), two dispatch-state notices (uncertain, executor_down_in_turn) plus one executor_down per restart, link active', async () => {
    const { env, worker } = await startLinkedCodexWorker(rig)
    const service = worker.composed.service
    env.client().responses['turn/start'] = () => {
      throw new Error('socket closed before the answer')
    }
    configureNewClients(env, client => {
      client.responses['thread/turns/list'] = () => {
        throw new Error('cannot read turns')
      }
    })
    await service.dispatch(AS_ORCHESTRATOR, { dispatchId: ID, to: EXECUTOR_NODE, text: 'go' })
    await settle()
    expect(rig.dispatchRow(ID)).toMatchObject({ state: 'uncertain' })

    await killService(env, 1000)
    await killService(env, 2000)
    await killService(env, 4000)
    expect(service.healthOf(EXECUTOR_NODE)).toBe('ready')
    await killService(env, 100)

    expect(service.healthOf(EXECUTOR_NODE)).toBe('unavailable')
    expect(rig.dispatchRow(ID)).toMatchObject({ state: 'failed', reason: 'executor_down' })
    expect(rig.linkRow()?.state).toBe('active')
    // ADR de despacho, linhas 175-176, e RC4 da onda 3: o `uncertain` vem do `send_uncertain`
    // do envio em tempo de execução, e o `executor_down_in_turn` da transição final; são dois
    // avisos de estado do despacho. Cada reinício só acrescenta um `executor_down`.
    expect(noticeKinds().filter(kind => kind !== 'executor_down')).toEqual([
      'uncertain',
      'executor_down_in_turn',
    ])
    const status = await service.status(AS_ORCHESTRATOR, {})
    expect(status.links[0].admission).toMatchObject({
      canDispatch: false,
      reason: 'executor_unavailable',
    })
  })

  it('restarts exhausted with a queued dispatch: failed(not_sent), round refunded, one notice, admission back after a restart', async () => {
    const { env, worker } = await startLinkedCodexWorker(rig)
    const service = worker.composed.service
    configureNewClients(env, client => {
      client.connect.mockRejectedValue(new Error('connection refused'))
    })
    await killService(env)
    await service.dispatch(AS_ORCHESTRATOR, { dispatchId: ID, to: EXECUTOR_NODE, text: 'go' })
    expect(rig.dispatchRow(ID)).toMatchObject({ state: 'queued' })
    await settle(8000)

    expect(service.healthOf(EXECUTOR_NODE)).toBe('unavailable')
    expect(rig.dispatchRow(ID)).toMatchObject({ state: 'failed', reason: 'not_sent' })
    expect(rig.linkRow()).toMatchObject({ roundsUsed: 0, state: 'active' })
    expect(noticeKinds().filter(kind => kind !== 'executor_down')).toEqual(['failed_not_sent'])

    configureNewClients(env, client => client.connect.mockResolvedValue('codex-cli 0.167.0'))
    await service.relaunchExecutorTui(EXECUTOR_NODE)
    await settle()
    expect(service.healthOf(EXECUTOR_NODE)).toBe('ready')
    const status = await service.status(AS_ORCHESTRATOR, {})
    expect(status.links[0].admission).toMatchObject({ canDispatch: true })
  })

  it('a turn whose answer was lost, then a death: the service finds no turn and the dispatch ends failed(not_sent) with the round refunded', async () => {
    const { env, worker } = await startLinkedCodexWorker(rig)
    env.client().responses['turn/start'] = () => {
      throw new Error('socket closed before the answer')
    }
    await worker.composed.service.dispatch(AS_ORCHESTRATOR, {
      dispatchId: ID,
      to: EXECUTOR_NODE,
      text: 'go',
    })
    await settle()
    expect(rig.dispatchRow(ID)).toMatchObject({ state: 'uncertain' })

    await killService(env, 1000)
    await settle()
    expect(rig.dispatchRow(ID)).toMatchObject({ state: 'failed', reason: 'not_sent' })
    expect(rig.linkRow()?.roundsUsed).toBe(0)
  })

  it.fails(
    'a death during a sent turn leaves the dispatch uncertain until the reconciliation (risk table, I-03)',
    async () => {
      const { env, worker } = await startLinkedCodexWorker(rig)
      await worker.composed.service.dispatch(AS_ORCHESTRATOR, {
        dispatchId: ID,
        to: EXECUTOR_NODE,
        text: 'go',
      })
      await settle()
      expect(rig.dispatchRow(ID)).toMatchObject({ state: 'sent' })

      await killService(env)
      expect(rig.dispatchRow(ID)).toMatchObject({ state: 'uncertain' })
    },
  )

  it.fails(
    'after executor.recovered the TUI is relaunched on the same node with the new service (risk table, I-03)',
    async () => {
      const { env, worker } = await startLinkedCodexWorker(rig)
      const launched = worker.spawnSession.mock.calls.length
      await killService(env, 1000)
      await settle()
      expect(env.clients).toHaveLength(2)
      expect(worker.spawnSession.mock.calls.length).toBe(launched + 1)
    },
  )
})

const REAL_CODEX = process.env.OPENCOVE_TEST_REAL_CODEX === '1'

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`condition not met within ${timeoutMs} ms`)
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

describe.skipIf(!REAL_CODEX)('I-03 service death over the real Codex app-server (opt-in)', () => {
  it('restarts after the launched pid dies and resumes the thread on the new service', async () => {
    vi.useRealTimers()
    const binary = process.env.OPENCOVE_TEST_CODEX_BIN ?? 'codex'
    const version = execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim()
    const home = await mkdtemp(join(tmpdir(), 'glimpse-f216-codex-'))
    const cwd = await mkdtemp(join(tmpdir(), 'glimpse-f216-cwd-'))
    const pids: number[] = []
    const methods: string[] = []
    const events: ExecutorRuntimeEvent[] = []
    const factory = createCodexExecutorRuntimeFactory({
      startProcess: async input => {
        const launched = await startCodexAppServer(input, {
          reserveLoopbackPort: () => reserveLoopbackPort('127.0.0.1'),
        })
        pids.push(launched.pid)
        return launched
      },
      createClient: target => {
        const client = new CodexJsonRpcClient(target)
        const request = client.request.bind(client)
        client.request = async (method, params) => {
          methods.push(method)
          return request(method, params)
        }
        return client
      },
      resolveExecutable: async () => ({ executablePath: binary, version }),
      approvedHooks: async () => [],
      readFullAccess: () => false,
      baseEnv: { ...process.env, CODEX_HOME: home },
    })
    const runtime = await factory.start({
      executorNodeId: EXECUTOR_NODE,
      provider: 'codex',
      cwd,
      env: {},
      sessionRef: null,
      model: null,
      policy: { approvals: 'user', sandbox: null },
    })
    try {
      runtime.subscribe(event => events.push(event))
      await runtime.ensureSession({ resumeRef: null, fresh: false })
      expect(pids).toHaveLength(1)
      expect(methods).toContain('thread/start')

      process.kill(pids[0], 'SIGKILL')
      await waitFor(
        () => pids.length === 2 && events.some(event => event.type === 'executor.recovered'),
        30_000,
      )

      expect(events.filter(event => event.type === 'executor.down')).toHaveLength(1)
      expect(methods).toContain('thread/resume')
      expect(await runtime.attachInfo()).toMatchObject({ cwd })
    } finally {
      await runtime.close('user')
      await rm(home, { recursive: true, force: true })
      await rm(cwd, { recursive: true, force: true })
    }
  }, 90_000)
})
