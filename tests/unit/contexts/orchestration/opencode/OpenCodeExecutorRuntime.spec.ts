/* eslint-disable no-await-in-loop -- sequential assertions. */
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  assistantMessage,
  idleMessage,
  ok,
  PASSWORD,
  PASSWORD_SHA,
  ready,
  SESSION,
  setup,
  userMessage,
} from './openCodeRuntimeHarness'

const flush = () => vi.advanceTimersByTimeAsync(0)

describe('OpenCodeExecutorRuntime (F3-01)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  describe('session', () => {
    it('creates the session with the location and the model and reports it as new', async () => {
      const env = setup()
      const runtime = await env.start()
      await expect(runtime.ensureSession({ resumeRef: null, fresh: false })).resolves.toEqual({
        sessionRef: SESSION,
        resumed: false,
      })
      expect(env.client().requests[0]).toEqual({
        method: 'POST',
        path: '/api/session',
        body: { title: 'Glimpse: Agente B', location: { directory: '/w' } },
      })
      expect(env.log).toContain('sse:connect')
    })

    it('resumes an existing session without creating another', async () => {
      const env = setup()
      const runtime = await env.start()
      await expect(runtime.ensureSession({ resumeRef: SESSION, fresh: false })).resolves.toEqual({
        sessionRef: SESSION,
        resumed: true,
      })
      expect(env.client().paths('POST')).not.toContain('/api/session')
    })

    it('creates a new session and reports resumed false when the old one is gone', async () => {
      const env = setup()
      const runtime = await env.start()
      env
        .client()
        .replies.push((method, path) =>
          method === 'GET' && path === '/api/session/ses_old' ? { status: 404 } : undefined,
        )
      env
        .client()
        .replies.push((method, path) =>
          method === 'POST' && path === '/api/session'
            ? ok({ data: { id: 'ses_new', time: { created: 10 } } })
            : undefined,
        )
      await expect(runtime.ensureSession({ resumeRef: 'ses_old', fresh: false })).resolves.toEqual({
        sessionRef: 'ses_new',
        resumed: false,
      })
    })

    it('fails with executor.session_lost when the replacement cannot be created', async () => {
      const env = setup()
      const runtime = await env.start()
      env
        .client()
        .replies.push((method, path) =>
          method === 'POST' && path === '/api/session' ? { status: 500 } : undefined,
        )
      await expect(
        runtime.ensureSession({ resumeRef: 'ses_old', fresh: false }),
      ).rejects.toMatchObject({ code: 'executor.session_lost' })
    })
  })
  describe('turn', () => {
    it('sends the deterministic msg_ id and no delivery field', async () => {
      const { runtime, client, idFor } = await ready()
      const turnRef = await runtime.startTurn({ dispatchId: 'disp-1', text: 'hi' })
      expect(turnRef.turnRef).toBe(idFor('disp-1'))
      expect(turnRef.turnRef).toMatch(/^msg_[0-9a-f]{32}$/)
      expect(client().requests.at(-1)).toEqual({
        method: 'POST',
        path: `/api/session/${SESSION}/prompt`,
        body: { id: idFor('disp-1'), text: 'hi' },
      })
    })

    it('produces the same msg_ for two calls with the same dispatchId and does not dedupe the POST', async () => {
      const { runtime, client, idFor } = await ready()
      const first = await runtime.startTurn({ dispatchId: 'disp-1', text: 'hi' })
      const second = await runtime.startTurn({ dispatchId: 'disp-1', text: 'hi' })
      expect(first.turnRef).toBe(second.turnRef)
      expect(first.turnRef).toBe(idFor('disp-1'))
      expect(
        client()
          .paths('POST')
          .filter(path => path.endsWith('/prompt')),
      ).toHaveLength(2)
    })

    it('is rejected on a 4xx before the acceptance', async () => {
      const { runtime, client } = await ready()
      client().replies.push((method, path) =>
        method === 'POST' && path.endsWith('/prompt') ? { status: 409 } : undefined,
      )
      await expect(runtime.startTurn({ dispatchId: 'd', text: 't' })).rejects.toMatchObject({
        code: 'executor.rejected',
      })
    })

    it('is send_uncertain when the answer never comes', async () => {
      const { runtime, client } = await ready()
      client().replies.push((method, path) => {
        if (method === 'POST' && path.endsWith('/prompt')) {
          return Object.assign(new Error('timeout'), { code: 'executor.send_uncertain' })
        }
        return undefined
      })
      await expect(runtime.startTurn({ dispatchId: 'd', text: 't' })).rejects.toMatchObject({
        code: 'executor.send_uncertain',
      })
    })

    it('finds a turn by the deterministic message and snapshots its end', async () => {
      const { runtime, client, idFor } = await ready()
      const id = idFor('disp-2')
      client().replies.push((method, path) =>
        method === 'GET' && path === `/api/session/${SESSION}/message/${id}`
          ? ok({ data: userMessage(id, 100) })
          : undefined,
      )
      client().replies.push((method, path) =>
        method === 'GET' && path.startsWith(`/api/session/${SESSION}/message?`)
          ? ok({
              data: [
                idleMessage('idle-1', 300),
                assistantMessage('as-1', 200, 'done', { input: 7, output: 3 }),
                userMessage(id, 100),
              ],
            })
          : undefined,
      )
      await expect(runtime.findTurnByDispatch('disp-2', new Date(0))).resolves.toEqual({
        kind: 'found',
        turn: {
          turnRef: id,
          status: 'completed',
          finalMessage: 'done',
          usage: { inputTokens: 7, outputTokens: 3 },
        },
      })
      expect(client().paths('GET')).toContain(`/api/session/${SESSION}/message?order=desc&limit=20`)
    })

    it('is absent only when the session was readable before the reservation and the message 404s', async () => {
      const { runtime, client, idFor } = await ready()
      const id = idFor('disp-x')
      client().replies.push((method, path) =>
        method === 'GET' && path === `/api/session/${SESSION}/message/${id}`
          ? { status: 404 }
          : undefined,
      )
      await expect(runtime.findTurnByDispatch('disp-x', new Date(5000))).resolves.toEqual({
        kind: 'absent',
      })
      client().replies.unshift((method, path) =>
        method === 'GET' && path === `/api/session/${SESSION}`
          ? ok({ data: { id: SESSION, time: { created: 9000 } } })
          : undefined,
      )
      await expect(runtime.findTurnByDispatch('disp-x', new Date(5000))).resolves.toEqual({
        kind: 'unknown',
      })
    })

    it('is unknown when the message cannot be read', async () => {
      const { runtime, client, idFor } = await ready()
      client().replies.push((method, path) =>
        method === 'GET' && path === `/api/session/${SESSION}/message/${idFor('d')}`
          ? { status: 500 }
          : undefined,
      )
      await expect(runtime.findTurnByDispatch('d', new Date(0))).resolves.toEqual({
        kind: 'unknown',
      })
    })

    it('reads a running turn as running and maps the idle outcome', async () => {
      const { runtime, client, idFor } = await ready()
      const id = idFor('d')
      client().replies.push((method, path) =>
        method === 'GET' && path === `/api/session/${SESSION}/message/${id}`
          ? ok({ data: userMessage(id, 100) })
          : undefined,
      )
      await expect(runtime.readTurn(id)).resolves.toEqual({
        turnRef: id,
        status: 'running',
        finalMessage: null,
        usage: null,
      })
      client().replies.unshift((method, path) =>
        method === 'GET' && path.startsWith(`/api/session/${SESSION}/message?`)
          ? ok({ data: [idleMessage('i', 300, 'interrupted'), userMessage(id, 100)] })
          : undefined,
      )
      await expect(runtime.readTurn(id)).resolves.toMatchObject({ status: 'interrupted' })
    })

    it('marks a turn without a Glimpse dispatch as screen', async () => {
      const { client, events } = await ready()
      client().replies.push((method, path) =>
        method === 'GET' && path.startsWith(`/api/session/${SESSION}/message?`)
          ? ok({ data: [userMessage('msg_screen', 500)] })
          : undefined,
      )
      client().emit({
        id: 'e1',
        type: 'session.execution.started',
        data: { sessionID: SESSION },
      })
      await flush()
      expect(events).toContainEqual({
        type: 'turn.started',
        turnRef: 'msg_screen',
        dispatchId: null,
        origin: 'screen',
      })
    })

    it('emits the completion with the last assistant text', async () => {
      const { runtime, client, events, idFor } = await ready()
      const id = idFor('d')
      await runtime.startTurn({ dispatchId: 'd', text: 'hi' })
      client().emit({ id: 'e1', type: 'session.execution.started', data: { sessionID: SESSION } })
      await flush()
      client().replies.push((method, path) =>
        method === 'GET' && path.startsWith(`/api/session/${SESSION}/message?`)
          ? ok({
              data: [
                idleMessage('i', 300),
                assistantMessage('a', 200, 'final'),
                userMessage(id, 100),
              ],
            })
          : undefined,
      )
      client().emit({
        id: 'e2',
        type: 'session.execution.succeeded',
        data: { sessionID: SESSION },
      })
      await flush()
      expect(events.at(-1)).toEqual({
        type: 'turn.completed',
        turnRef: id,
        dispatchId: 'd',
        outcome: 'completed',
        finalMessage: 'final',
        usage: null,
      })
    })
  })
  describe('approvals and interrupt', () => {
    const request = {
      id: 'perm_1',
      sessionID: SESSION,
      action: 'bash',
      resources: ['ls -la'],
      message: 'run ls',
    }

    it('announces a permission from the stream and maps the decision', async () => {
      const { runtime, client, events } = await ready()
      client().emit({ id: 'e', type: 'permission.asked', data: request })
      expect(events.at(-1)).toEqual({
        type: 'approval.requested',
        requestId: 'perm_1',
        kind: 'bash',
        summary: 'run ls',
        turnRef: null,
      })
      await expect(runtime.respondApproval('perm_1', 'approve')).resolves.toEqual({ ok: true })
      expect(client().requests.at(-1)).toEqual({
        method: 'POST',
        path: `/api/session/${SESSION}/permission/perm_1/reply`,
        body: { decision: 'once' },
      })
      const decisions: [string, string][] = [
        ['approve_for_session', 'always'],
        ['deny', 'reject'],
      ]
      for (const [decision, expected] of decisions) {
        client().emit({
          id: 'e',
          type: 'permission.asked',
          data: { ...request, id: `p-${decision}` },
        })
        await runtime.respondApproval(`p-${decision}`, decision as never)
        expect(client().requests.at(-1)!.body).toEqual({ decision: expected })
      }
    })

    it('cancels with reject followed by interrupt', async () => {
      const { runtime, client } = await ready()
      client().emit({ id: 'e', type: 'permission.asked', data: { ...request, id: 'perm_2' } })
      await runtime.respondApproval('perm_2', 'cancel')
      const posts = client()
        .requests.filter(entry => entry.method === 'POST')
        .slice(-2)
      expect(posts[0].body).toEqual({ decision: 'reject' })
      expect(posts[1].path).toBe(`/api/session/${SESSION}/interrupt`)
    })

    it('reports approval_not_found on 404 and does not repeat the request', async () => {
      const { runtime, client } = await ready()
      client().replies.push((method, path) =>
        method === 'POST' && path.endsWith('/permission/gone/reply') ? { status: 404 } : undefined,
      )
      await expect(runtime.respondApproval('gone', 'approve')).resolves.toEqual({
        ok: false,
        reason: 'approval_not_found',
      })
      client().emit({ id: 'e', type: 'permission.asked', data: request })
      await expect(runtime.respondApproval('perm_1', 'approve')).resolves.toEqual({ ok: true })
      await expect(runtime.respondApproval('perm_1', 'approve')).resolves.toEqual({ ok: true })
      expect(
        client()
          .paths('POST')
          .filter(path => path.endsWith('/permission/perm_1/reply')),
      ).toHaveLength(1)
    })

    it('resolves from the screen without a POST and leaves the retry to the Glimpse', async () => {
      const { runtime, client, events } = await ready()
      client().emit({ id: 'e', type: 'permission.asked', data: request })
      client().emit({
        id: 'e2',
        type: 'permission.replied',
        data: { sessionID: SESSION, requestID: 'perm_1', reply: 'once' },
      })
      expect(events.at(-1)).toEqual({
        type: 'approval.resolved',
        requestId: 'perm_1',
        resolvedBy: 'screen',
      })
      await expect(runtime.respondApproval('perm_1', 'approve')).resolves.toEqual({
        ok: false,
        reason: 'approval_not_found',
      })
    })

    it('reads the pending permissions after the stream reconnects', async () => {
      const { client, events } = await ready()
      client().replies.push((method, path) =>
        method === 'GET' && path === `/api/session/${SESSION}/permission`
          ? ok({ data: [request] })
          : undefined,
      )
      client().setState('reconnecting')
      expect(events.at(-1)).toMatchObject({ type: 'executor.degraded' })
      client().setState('connected')
      await flush()
      expect(events.filter(event => event.type === 'approval.requested')).toHaveLength(1)
      expect(events.at(-1)).toMatchObject({ type: 'executor.ready', sessionRef: SESSION })
    })

    it('interrupts the session and tolerates an idle answer', async () => {
      const { runtime, client } = await ready()
      await expect(runtime.interrupt()).resolves.toBeUndefined()
      expect(client().paths('POST')).toContain(`/api/session/${SESSION}/interrupt`)
    })
  })
  describe('health and lifecycle', () => {
    it('degrades once per unknown event type and keeps the service alive', async () => {
      const { client, events } = await ready()
      client().emit({ id: 'e1', type: 'weird.event', data: { sessionID: SESSION } })
      client().emit({ id: 'e2', type: 'weird.event', data: { sessionID: SESSION } })
      const degraded = events.filter(event => event.type === 'executor.degraded')
      expect(degraded).toEqual([{ type: 'executor.degraded', reason: 'unknown_event:weird.event' }])
      await expect(client().get('/api/session')).resolves.toBeDefined()
    })

    it('ignores the streaming events without degrading', async () => {
      const { client, events } = await ready()
      client().emit({ id: 'e', type: 'session.text.delta', data: { sessionID: SESSION } })
      expect(events.filter(event => event.type === 'executor.degraded')).toEqual([])
    })

    it('closes the dead stream, restarts in 1 s and never degrades after recovered', async () => {
      const { runtime, processes, events, clients } = await ready()
      const kinds = () => events.map(event => event.type).join(',')
      await runtime.startTurn({ dispatchId: 'd', text: 't' })
      processes[0].exit(1, null)
      await flush()
      expect(kinds()).toBe('executor.degraded,executor.down')
      expect(events[0]).toEqual({ type: 'executor.degraded', reason: 'sse_disconnected' })
      await vi.advanceTimersByTimeAsync(1000)
      expect(clients).toHaveLength(2)
      expect(clients[1].paths('GET')).toContain(`/api/session/${SESSION}`)
      expect(kinds()).toBe('executor.degraded,executor.down,executor.ready,executor.recovered')
      expect(events[2]).toMatchObject({ sessionRef: SESSION, resumed: true, version: '2.3.0' })
      await vi.advanceTimersByTimeAsync(10_000)
      expect(kinds()).toBe('executor.degraded,executor.down,executor.ready,executor.recovered')
      expect(clients[0].closed).toBe(true)
    })

    it('restarts in 1, 2 and 4 s and gives up on the fourth death in the window', async () => {
      const { processes, events, clients } = await ready()
      const restartAfter = async (delayMs: number, expected: number) => {
        processes.at(-1)!.exit(1, null)
        await flush()
        await vi.advanceTimersByTimeAsync(delayMs - 1)
        expect(clients).toHaveLength(expected - 1)
        await vi.advanceTimersByTimeAsync(1)
        expect(clients).toHaveLength(expected)
      }
      await restartAfter(1000, 2)
      await restartAfter(2000, 3)
      await restartAfter(4000, 4)
      processes.at(-1)!.exit(1, null)
      await flush()
      expect(events.filter(event => event.type === 'executor.down').at(-1)).toEqual({
        type: 'executor.down',
        reason: 'restarts_exhausted',
        exitCode: null,
        signal: null,
      })
    })

    it('interrupts before the SIGTERM on close and never archives', async () => {
      const { runtime, client, log } = await ready()
      await runtime.startTurn({ dispatchId: 'd', text: 't' })
      await runtime.close('user')
      expect(log.slice(-3)).toEqual([
        `post:/api/session/${SESSION}/interrupt`,
        'sse:close',
        'sigterm',
      ])
      expect(
        client()
          .paths('POST')
          .some(path => path.includes('archive')),
      ).toBe(false)
    })

    it('describes the attach and the identity without leaking the password', async () => {
      const { runtime } = await ready()
      await expect(runtime.attachInfo()).resolves.toEqual({
        url: 'http://127.0.0.1:4401',
        tokenEnv: { name: 'OPENCODE_SERVER_PASSWORD', value: PASSWORD },
        sessionRef: SESSION,
        cwd: '/w',
      })
      const identity = await runtime.serviceIdentity()
      expect(identity).toEqual({ pid: 8123, tokenSha256: PASSWORD_SHA })
      expect(JSON.stringify(identity)).not.toContain(PASSWORD)
    })

    it.each([-1, 0, 1])('gives null identity for pid %i', async pid => {
      const { runtime } = await ready({ pid })
      await expect(runtime.serviceIdentity()).resolves.toBeNull()
    })

    it('filters OPENCOVE_* and passes the provider environment', async () => {
      const env = setup()
      await env.start()
      expect(env.startInputs[0].env).toEqual({
        PATH: '/bin',
        HOME: '/home/u',
        ANTHROPIC_API_KEY: 'k',
      })
      expect(env.startInputs[0].cwd).toBe('/w')
    })
  })
  describe('factory probe', () => {
    it('is compatible from 2.2.6 and refuses older versions', async () => {
      await expect(setup({ version: 'v2.2.6' }).factory.probe()).resolves.toEqual({
        executablePath: '/bin/opencode',
        version: 'v2.2.6',
        compatible: true,
      })
      await expect(setup({ version: '2.2.5' }).factory.probe()).resolves.toMatchObject({
        compatible: false,
      })
      await expect(setup({ version: 'garbage' }).factory.probe()).resolves.toMatchObject({
        compatible: false,
      })
    })
  })
})
