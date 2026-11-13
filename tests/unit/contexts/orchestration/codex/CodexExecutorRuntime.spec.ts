/* eslint-disable no-await-in-loop -- sequential assertions. */
// @vitest-environment node
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  agentMessage,
  APPROVAL,
  BLOCKED,
  flush,
  ready,
  setup,
  turn,
  userMessage,
} from './codexRuntimeHarness'

describe('CodexExecutorRuntime (F2-11)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  describe('session and turn', () => {
    it('starts the thread with the policy from the factory and names it', async () => {
      const { runtime, client } = await ready()
      const start = client().requests.find(entry => entry.method === 'thread/start')!
      expect(start.params).toMatchObject({
        cwd: '/w',
        sandbox: 'workspace-write',
        approvalPolicy: 'on-request',
        ephemeral: false,
        serviceName: 'glimpse',
      })
      const named = client().requests.find(entry => entry.method === 'thread/name/set')!
      expect(named.params).toEqual({ threadId: 'thr-1', name: 'Glimpse: Agente A' })
      await expect(runtime.attachInfo()).resolves.toEqual({
        url: 'ws://127.0.0.1:5',
        tokenEnv: { name: 'OPENCOVE_EXECUTOR_REMOTE_TOKEN', value: 'tok' },
        sessionRef: 'thr-1',
        cwd: '/w',
      })
    })

    it('resumes the given thread and reports session_lost when it is gone', async () => {
      const env = setup()
      const runtime = await env.start()
      await expect(runtime.ensureSession({ resumeRef: 'thr-9', fresh: false })).resolves.toEqual({
        sessionRef: 'thr-1',
        resumed: true,
      })
      expect(env.client().methods()).not.toContain('thread/start')
      env.client().responses['thread/resume'] = () => {
        throw Object.assign(new Error('no rollout found'), { code: 'executor.rejected' })
      }
      await expect(
        runtime.ensureSession({ resumeRef: 'thr-9', fresh: false }),
      ).rejects.toMatchObject({
        code: 'executor.session_lost',
      })
    })

    it('sends turn/start with clientUserMessageId equal to the dispatchId', async () => {
      const { runtime, client } = await ready()
      await expect(runtime.startTurn({ dispatchId: 'disp-1', text: 'hi' })).resolves.toEqual({
        turnRef: 'turn-1',
      })
      const sent = client().requests.find(entry => entry.method === 'turn/start')!
      expect(sent.params).toEqual({
        threadId: 'thr-1',
        input: [{ type: 'text', text: 'hi', text_elements: [] }],
        clientUserMessageId: 'disp-1',
      })
    })

    it('maps notifications to events and uses the last agentMessage as final message', async () => {
      const { runtime, client, events } = await ready()
      await runtime.startTurn({ dispatchId: 'disp-1', text: 'hi' })
      const c = client()
      c.notify('turn/started', {
        threadId: 'thr-1',
        turn: turn('turn-1', 'inProgress', [userMessage('disp-1')]),
      })
      c.notify('item/completed', {
        threadId: 'thr-1',
        turnId: 'turn-1',
        item: agentMessage('first'),
      })
      c.notify('item/completed', {
        threadId: 'thr-1',
        turnId: 'turn-1',
        item: agentMessage('last'),
      })
      c.notify('turn/completed', { threadId: 'thr-1', turn: turn('turn-1', 'completed') })
      expect(events).toEqual([
        { type: 'turn.started', turnRef: 'turn-1', dispatchId: 'disp-1', origin: 'glimpse' },
        {
          type: 'turn.completed',
          turnRef: 'turn-1',
          dispatchId: 'disp-1',
          outcome: 'completed',
          finalMessage: 'last',
          usage: null,
        },
      ])
    })

    it('covers the status table and flags turns without a Glimpse client id as screen', async () => {
      const { client, events } = await ready()
      const c = client()
      const cases: [string, string][] = [
        ['completed', 'completed'],
        ['interrupted', 'interrupted'],
        ['failed', 'failed'],
      ]
      cases.forEach(([status], index) => {
        const id = `t${index}`
        c.notify('turn/started', {
          threadId: 'thr-1',
          turn: turn(id, 'inProgress', [userMessage(null)]),
        })
        c.notify('turn/completed', { threadId: 'thr-1', turn: turn(id, status) })
      })
      const completed = events.filter(event => event.type === 'turn.completed')
      expect(completed.map(event => (event as { outcome: string }).outcome)).toEqual(
        cases.map(([, outcome]) => outcome),
      )
      expect(events[0]).toMatchObject({ type: 'turn.started', dispatchId: null, origin: 'screen' })
      expect(completed[0]).toMatchObject({ dispatchId: null, finalMessage: null })
    })

    it('ignores notifications of other threads', async () => {
      const { client, events } = await ready()
      client().notify('turn/started', { threadId: 'other', turn: turn('x', 'inProgress') })
      expect(events).toEqual([])
    })
  })

  describe('findTurnByDispatch and readTurn', () => {
    it('finds the turn by the clientId of its userMessage', async () => {
      const { runtime, client } = await ready()
      client().responses['thread/turns/list'] = () => ({
        data: [
          turn('t2', 'completed', [userMessage('disp-2'), agentMessage('done')]),
          turn('t1', 'inProgress', [userMessage('disp-1')]),
        ],
        nextCursor: null,
      })
      await expect(runtime.findTurnByDispatch('disp-2', new Date(0))).resolves.toEqual({
        kind: 'found',
        turn: { turnRef: 't2', status: 'completed', finalMessage: 'done', usage: null },
      })
      expect(client().requests.at(-1)!.params).toMatchObject({
        threadId: 'thr-1',
        limit: 20,
        sortDirection: 'desc',
      })
      await expect(runtime.readTurn('t1')).resolves.toMatchObject({
        turnRef: 't1',
        status: 'running',
      })
    })

    it('is absent only when the list is readable back to the reservation', async () => {
      const { runtime, client } = await ready()
      client().responses['thread/turns/list'] = () => ({
        data: [turn('t1', 'completed')],
        nextCursor: null,
      })
      await expect(runtime.findTurnByDispatch('nope', new Date(0))).resolves.toEqual({
        kind: 'absent',
      })
      client().responses['thread/turns/list'] = () => ({
        data: [{ ...turn('t1', 'completed'), startedAt: 2000 }],
        nextCursor: 'more',
      })
      await expect(runtime.findTurnByDispatch('nope', new Date(3_000_000))).resolves.toEqual({
        kind: 'absent',
      })
      await expect(runtime.findTurnByDispatch('nope', new Date(1_000_000))).resolves.toEqual({
        kind: 'unknown',
      })
    })

    it('is unknown when the list cannot be read', async () => {
      const { runtime, client } = await ready()
      client().responses['thread/turns/list'] = () => {
        throw new Error('boom')
      }
      await expect(runtime.findTurnByDispatch('d', new Date(0))).resolves.toEqual({
        kind: 'unknown',
      })
    })
  })

  describe('approvals', () => {
    const params = { threadId: 'thr-1', turnId: 'turn-1', itemId: 'i', command: 'ls' }

    it('keeps the request pending until answered, then answers the server 1 for 1', async () => {
      const decisions = [
        ['approve', 'accept'],
        ['approve_for_session', 'acceptForSession'],
        ['deny', 'decline'],
        ['cancel', 'cancel'],
      ] as const
      const { runtime, client, events } = await ready()
      for (const [index, [decision, expected]] of decisions.entries()) {
        const answer = client().serverRequest(APPROVAL, params, `r${index}`)!
        let settled = false
        void answer.then(() => (settled = true))
        await flush()
        expect(settled).toBe(false)
        expect(events.at(-1)).toMatchObject({
          type: 'approval.requested',
          requestId: `r${index}`,
          turnRef: 'turn-1',
        })
        await expect(runtime.respondApproval(`r${index}`, decision)).resolves.toEqual({ ok: true })
        await expect(answer).resolves.toEqual({ decision: expected })
        expect(events.at(-1)).toEqual({
          type: 'approval.resolved',
          requestId: `r${index}`,
          resolvedBy: 'glimpse',
        })
      }
    })

    it('cancel also interrupts the active turn, deny does not', async () => {
      const { runtime, client } = await ready()
      client().notify('turn/started', { threadId: 'thr-1', turn: turn('turn-1', 'inProgress') })
      void client().serverRequest(APPROVAL, params, 'r1')
      await runtime.respondApproval('r1', 'deny')
      expect(client().methods()).not.toContain('turn/interrupt')
      void client().serverRequest(APPROVAL, params, 'r2')
      await runtime.respondApproval('r2', 'cancel')
      const interrupt = client().requests.find(entry => entry.method === 'turn/interrupt')!
      expect(interrupt.params).toEqual({ threadId: 'thr-1', turnId: 'turn-1' })
    })

    it('closes on serverRequest/resolved from the screen and is idempotent by requestId', async () => {
      const { runtime, client, events } = await ready()
      void client().serverRequest(APPROVAL, params, 'r1')
      client().notify('serverRequest/resolved', { threadId: 'thr-1', requestId: 'r1' })
      expect(events.at(-1)).toEqual({
        type: 'approval.resolved',
        requestId: 'r1',
        resolvedBy: 'screen',
      })
      await expect(runtime.respondApproval('r1', 'approve')).resolves.toEqual({
        ok: false,
        reason: 'approval_not_found',
      })
      void client().serverRequest(APPROVAL, params, 'r2')
      await runtime.respondApproval('r2', 'approve')
      await expect(runtime.respondApproval('r2', 'approve')).resolves.toEqual({ ok: true })
      expect(events.filter(event => event.type === 'approval.resolved')).toHaveLength(2)
    })

    it('answers permissions and elicitation in their own shapes', async () => {
      const { runtime, client } = await ready()
      const permissions = client().serverRequest(
        'item/permissions/requestApproval',
        { ...params, permissions: { network: { enabled: true } } },
        'p1',
      )!
      await runtime.respondApproval('p1', 'approve_for_session')
      await expect(permissions).resolves.toEqual({
        permissions: { network: { enabled: true } },
        scope: 'session',
      })
      const elicitation = client().serverRequest(
        'mcpServer/elicitation/request',
        { message: 'm' },
        'e1',
      )!
      await runtime.respondApproval('e1', 'deny')
      await expect(elicitation).resolves.toEqual({ action: 'decline', content: null })
    })

    it('leaves unknown methods to the -32601 of the client and degrades', async () => {
      const { client, events } = await ready()
      expect(client().serverRequest('weird/method', {}, 'w1')).toBeNull()
      expect(events.at(-1)).toMatchObject({ type: 'executor.degraded' })
    })
  })

  describe('interrupt, blocked methods and sandbox', () => {
    it('interrupts the given or the active turn and does nothing when idle', async () => {
      const { runtime, client } = await ready()
      await runtime.interrupt()
      expect(client().methods()).not.toContain('turn/interrupt')
      await runtime.interrupt('turn-7')
      client().notify('turn/started', { threadId: 'thr-1', turn: turn('turn-2', 'inProgress') })
      await runtime.interrupt()
      const sent = client().requests.filter(entry => entry.method === 'turn/interrupt')
      expect(sent.map(entry => (entry.params as { turnId: string }).turnId)).toEqual([
        'turn-7',
        'turn-2',
      ])
    })

    it('never sends a blocked method across a full lifecycle', async () => {
      const { runtime, client } = await ready()
      await runtime.startTurn({ dispatchId: 'd', text: 't' })
      await runtime.findTurnByDispatch('d', new Date(0))
      await runtime.interrupt('turn-1')
      await runtime.close('user')
      expect(
        client()
          .methods()
          .filter(method => BLOCKED.includes(method)),
      ).toEqual([])
    })

    it('reads the full access option at start and ignores policy.sandbox', async () => {
      let fullAccess = true
      const env = setup({ fullAccess: () => fullAccess })
      const runtime = await env.start()
      fullAccess = false
      await runtime.ensureSession({ resumeRef: null, fresh: false })
      const start = env.client().requests.find(entry => entry.method === 'thread/start')!
      expect(start.params).toMatchObject({ sandbox: 'danger-full-access', approvalPolicy: 'never' })
    })
  })

  describe('service identity', () => {
    it('gives pid and token hash and never the token', async () => {
      const { runtime } = await ready()
      const identity = await runtime.serviceIdentity()
      expect(identity).toEqual({
        pid: 4242,
        tokenSha256: createHash('sha256').update('tok').digest('hex'),
      })
      expect(JSON.stringify(identity)).not.toContain('"tok"')
    })

    it.each([-1, 0, 1])('gives null for pid %i', async pid => {
      const { runtime } = await ready({ pid })
      await expect(runtime.serviceIdentity()).resolves.toBeNull()
    })

    it('gives null once the service exited', async () => {
      const { runtime, processes } = await ready()
      processes[0].exit(0, null)
      await flush()
      await expect(runtime.serviceIdentity()).resolves.toBeNull()
    })
  })
})
