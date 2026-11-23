/* eslint-disable no-await-in-loop -- sequential assertions. */
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flush, ready, setup, turn } from './codexRuntimeHarness'

describe('CodexExecutorRuntime lifecycle (F2-11)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  describe('hooks and process arguments', () => {
    it('passes approved pairs as overrides and filters OPENCOVE_ from the environment', async () => {
      const env = setup({ approved: [{ key: 'k', currentHash: 'h' }] })
      await env.start()
      expect(env.startInputs[0].hookTrust).toEqual([{ key: 'k', trustedHash: 'h' }])
      expect(env.startInputs[0].env).toEqual({ PATH: '/bin', OPENAI_API_KEY: 'k' })
    })

    it('emits hooks.trust_pending for untrusted hooks without approval', async () => {
      const env = setup()
      const runtime = await env.start()
      env.client().responses['hooks/list'] = () => ({
        data: [
          {
            cwd: '/w',
            hooks: [
              { key: 'k', currentHash: 'h', trustStatus: 'untrusted', eventName: 'preToolUse' },
            ],
          },
        ],
      })
      await runtime.ensureSession({ resumeRef: null, fresh: false })
      expect(env.events.at(-1)).toEqual({
        type: 'hooks.trust_pending',
        hooks: [{ key: 'k', event: 'preToolUse', origin: 'untrusted', currentHash: 'h' }],
      })
      expect(env.client().requests.find(entry => entry.method === 'hooks/list')!.params).toEqual({
        cwds: ['/w'],
      })
    })
  })

  describe('health and lifecycle', () => {
    it('pings every 15 s and turns two failures into one degraded, then ready again', async () => {
      const { client, events } = await ready()
      await vi.advanceTimersByTimeAsync(15_000)
      expect(client().ping).toHaveBeenCalledTimes(1)
      client().pingFails = true
      await vi.advanceTimersByTimeAsync(15_000)
      expect(events).toEqual([])
      await vi.advanceTimersByTimeAsync(15_000)
      await vi.advanceTimersByTimeAsync(15_000)
      expect(events.filter(event => event.type === 'executor.degraded')).toHaveLength(1)
      client().pingFails = false
      await vi.advanceTimersByTimeAsync(15_000)
      expect(events.at(-1)).toMatchObject({
        type: 'executor.ready',
        sessionRef: 'thr-1',
        resumed: true,
      })
    })

    it('emits down, then ready, then recovered after the supervisor restarts the service', async () => {
      const { runtime, processes, events, clients } = await ready()
      await runtime.startTurn({ dispatchId: 'd', text: 't' })
      processes[0].exit(1, null)
      await flush()
      expect(events).toEqual([
        { type: 'executor.down', reason: 'process_exit', exitCode: 1, signal: null },
      ])
      await vi.advanceTimersByTimeAsync(1000)
      expect(clients).toHaveLength(2)
      expect(clients[1].methods()).toContain('thread/resume')
      expect(events.map(event => event.type)).toEqual([
        'executor.down',
        'executor.ready',
        'executor.recovered',
      ])
      expect(events[1]).toMatchObject({ resumed: true, sessionRef: 'thr-1', version: '0.167.0' })
      expect(events[2]).toEqual({ type: 'executor.recovered', sessionRef: 'thr-1' })
    })

    it('gives up after the restart budget and says so in a last executor.down', async () => {
      const { processes, events } = await ready()
      for (let round = 0; round < 4; round += 1) {
        processes.at(-1)!.exit(1, null)
        await vi.advanceTimersByTimeAsync(5000)
      }
      expect(events.filter(event => event.type === 'executor.down').at(-1)).toMatchObject({
        reason: 'restarts_exhausted',
      })
    })

    it('close archives the thread before the SIGTERM, except on app exit', async () => {
      const first = await ready()
      await first.runtime.close('user')
      expect(
        first.log.filter(entry => entry === 'sigterm' || entry === 'req:thread/archive'),
      ).toEqual(['req:thread/archive', 'sigterm'])
      const second = await ready()
      await second.runtime.close('shutdown')
      expect(second.client().methods()).not.toContain('thread/archive')
      expect(second.processes[0].close).toHaveBeenCalledTimes(1)
    })

    it('interrupts an active turn before archiving and tolerates an archive failure', async () => {
      const { runtime, client, log, processes } = await ready()
      client().notify('turn/started', { threadId: 'thr-1', turn: turn('turn-1', 'inProgress') })
      client().responses['thread/archive'] = () => {
        throw new Error('boom')
      }
      await runtime.close('node_deleted')
      expect(
        log.filter(entry =>
          ['req:turn/interrupt', 'req:thread/archive', 'sigterm'].includes(entry),
        ),
      ).toEqual(['req:turn/interrupt', 'req:thread/archive', 'sigterm'])
      expect(processes[0].close).toHaveBeenCalledTimes(1)
    })
  })

  describe('factory probe', () => {
    it('is compatible from 0.167.0 on', async () => {
      const { factory } = setup()
      await expect(factory.probe()).resolves.toEqual({
        executablePath: '/bin/codex',
        version: '0.167.0',
        compatible: true,
      })
    })
  })
})
