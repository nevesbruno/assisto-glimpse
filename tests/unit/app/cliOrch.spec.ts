// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { run } from '../../../src/app/cli/core/run'
import type { CliIo } from '../../../src/app/cli/core/io'

const ID = '91c2aaaa-0000-4000-8000-000000000001'
const OTHER = '7f3a0000-0000-4000-8000-000000000002'
const free = { canDispatch: true, reason: null, blocking: null, willWait: false }
const blockedBy = (dispatchId: string, state = 'sent', round = 1) => ({
  canDispatch: false,
  reason: 'dispatch_in_flight',
  blocking: { dispatchId, state, round },
  willWait: false,
})

/** Fake Control Surface: counts one acceptance per dispatchId and logs stdout, stderr and fetch order. */
function server(opts: { hang?: boolean; inFlight?: boolean; status?: unknown } = {}) {
  const order: string[] = []
  const accepted = new Set<string>()
  const bodies: { id: string; payload: Record<string, string> }[] = []
  let out = '',
    err = ''
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    bodies.push(body)
    order.push(`fetch:${body.id}`)
    if (opts.hang) {
      await new Promise((_, reject) =>
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
      )
    }
    const reply = (value: unknown) => new Response(JSON.stringify({ ok: true, value }))
    if (body.id === 'orch.dispatch') {
      if (opts.inFlight) {
        return new Response(
          JSON.stringify({
            ok: false,
            error: {
              code: 'orch.dispatch_in_flight',
              debugMessage: 'in flight',
              details: { dispatchId: OTHER, state: 'sent', round: 1 },
            },
          }),
        )
      }
      const duplicate = accepted.has(body.payload.dispatchId)
      accepted.add(body.payload.dispatchId)
      return reply({
        dispatchId: body.payload.dispatchId,
        state: 'queued',
        round: 2,
        roundsLimit: 3,
        duplicate,
        admission: blockedBy(body.payload.dispatchId, 'queued', 2),
      })
    }
    if (body.id === 'orch.status') {
      return reply(opts.status ?? { linksRevision: 1, links: [] })
    }
    if (body.id === 'orch.spawn') {
      return reply({
        executorNodeId: 'exec-api',
        linkId: ID,
        runtimeMode: 'service',
        duplicate: false,
        dispatch: { dispatchId: OTHER, state: 'queued', round: 1, roundsLimit: 3 },
        admission: free,
      })
    }
    if (body.id === 'orch.cancel') {
      return reply({ dispatchId: body.payload.dispatchId, state: 'cancelled', round: 1 })
    }
    return reply({})
  })
  const io: CliIo = {
    stdout: { write: t => ((out += t), order.push('stdout')) },
    stderr: { write: t => ((err += t), order.push('stderr')) },
    env: { OPENCOVE_CONTROL_URL: 'http://fake', OPENCOVE_CONTROL_TOKEN: 'fake' },
    fetch: fetch as unknown as typeof globalThis.fetch,
    now: () => Date.parse('2026-11-09T12:03:00Z'),
    readTextFile: vi.fn(async () => 'from file'),
    readStdinText: vi.fn(async () => 'from stdin'),
  }
  return { io, fetch, order, bodies, accepted, out: () => out, err: () => err }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.parse('2026-11-09T12:03:00Z'))
})
afterEach(() => vi.useRealTimers())

const dispatchBodies = (s: ReturnType<typeof server>) =>
  s.bodies.filter(b => b.id === 'orch.dispatch')

it.each([
  ['spawn'],
  ['dispatch'],
  ['status'],
  ['cancel'],
  ['interrupt'],
  ['close'],
  ['link', 'create'],
  ['link', 'close'],
  ['link', 'list'],
  ['link', 'extend'],
  ['approval', 'respond'],
  ['hooks', 'approve'],
])('orch %s has help without a connection', async (...path) => {
  const s = server()
  expect(await run(['orch', ...path, '--help'], s.io)).toBe(0)
  expect(s.out()).toContain(`opencove orch ${path.join(' ')}`)
  expect(s.fetch).not.toHaveBeenCalled()
})

it('dispatch help offers --text and --file, never --allow-repeat, and documents --id', async () => {
  const s = server()
  await run(['orch', 'dispatch', '--help'], s.io)
  expect(s.out()).toContain('--text')
  expect(s.out()).toContain('--file')
  expect(s.out()).toContain('--id')
  expect(s.out()).not.toContain('allow-repeat')
  const f = server()
  expect(await run(['orch', 'dispatch', '--to', 'x', '--text', 't', '--allow-repeat'], f.io)).toBe(
    2,
  )
  expect(f.fetch).not.toHaveBeenCalled()
})

it.each([[[]], [['--text', 'a', '--file', 'f']]])(
  'dispatch requires exactly one of --text and --file: %j',
  async flags => {
    const s = server()
    expect(await run(['orch', 'dispatch', '--to', 'exec-api', ...flags], s.io)).toBe(2)
    expect(s.fetch).not.toHaveBeenCalled()
  },
)

it('prints the dispatchId before calling the Worker', async () => {
  const s = server()
  expect(await run(['orch', 'dispatch', '--to', 'exec-api', '--text', 'task'], s.io)).toBe(0)
  const sent = dispatchBodies(s)[0].payload
  expect(sent).toMatchObject({ to: 'exec-api', text: 'task' })
  expect(s.err()).toContain(sent.dispatchId)
  expect(s.order.indexOf('stderr')).toBeLessThan(s.order.indexOf('fetch:orch.dispatch'))
})

it('accepted dispatch tells to wait for the notice and shows no queue position', async () => {
  const s = server()
  await run(['orch', 'dispatch', '--to', 'exec-api', '--text', 'task', '--id', ID], s.io)
  expect(s.out()).toBe(
    'despacho 91c2 aceito para exec-api, rodada 2/3; aguarde o aviso antes de enviar o próximo\n',
  )
  expect(s.out()).not.toMatch(/fila|posi/i)
})

it('reads the text from --file and stdin', async () => {
  const f = server()
  expect(await run(['orch', 'dispatch', '--to', 'e', '--file', '/tmp/t'], f.io)).toBe(0)
  expect(dispatchBodies(f)[0].payload.text).toBe('from file')
  const g = server()
  expect(await run(['orch', 'dispatch', '--to', 'e', '--file', '-'], g.io)).toBe(0)
  expect(dispatchBodies(g)[0].payload.text).toBe('from stdin')
})

it('a retry with --id reuses the dispatchId and the fake server counts one acceptance', async () => {
  const s = server()
  const argv = ['orch', 'dispatch', '--to', 'exec-api', '--text', 'task', '--id', ID]
  expect(await run(argv, s.io)).toBe(0)
  expect(await run(argv, s.io)).toBe(0)
  expect(dispatchBodies(s).map(b => b.payload.dispatchId)).toEqual([ID, ID])
  expect(s.accepted.size).toBe(1)
  expect(s.out()).toContain('já registrado')
})

it('generates a fresh dispatchId per invocation without --id', async () => {
  const s = server()
  const argv = ['orch', 'dispatch', '--to', 'exec-api', '--text', 'task']
  await run(argv, s.io)
  await run(argv, s.io)
  expect(s.accepted.size).toBe(2)
})

it('refuses an invalid --id before the Worker is called', async () => {
  const s = server()
  expect(await run(['orch', 'dispatch', '--to', 'e', '--text', 't', '--id', 'nope'], s.io)).toBe(2)
  expect(s.fetch).not.toHaveBeenCalled()
})

it('orch.dispatch_in_flight prints the blocking dispatch and exits 1', async () => {
  const s = server({ inFlight: true })
  expect(await run(['orch', 'dispatch', '--to', 'exec-api', '--text', 'task'], s.io)).toBe(1)
  const error = JSON.parse(s.err().trim().split('\n').at(-1)!).error
  expect(error.code).toBe('orch.dispatch_in_flight')
  expect(error.message).toBe(
    'recusado: despacho 7f3a de exec-api em andamento (sent, rodada 1); aguarde o aviso',
  )
  expect(error.details).toMatchObject({ dispatchId: OTHER })
})

it('exits 124 on timeout and the printed dispatchId is reusable', async () => {
  const s = server({ hang: true })
  expect(
    await run(['orch', 'dispatch', '--to', 'e', '--text', 't', '--timeout', '30ms'], s.io),
  ).toBe(124)
  const printed = dispatchBodies(s)[0].payload.dispatchId
  expect(s.err()).toContain(printed)
})

const link = (overrides: Record<string, unknown> = {}) => ({
  linkId: ID,
  executorNodeId: 'n1',
  title: 'exec-api',
  provider: 'codex',
  runtimeMode: 'service',
  health: 'busy',
  roundsUsed: 2,
  roundsLimit: 3,
  admission: blockedBy('91c2aaaa-0000-4000-8000-000000000001', 'sent', 2),
  current: {
    dispatchId: '91c2aaaa-0000-4000-8000-000000000001',
    state: 'sent',
    round: 2,
    reason: null,
    outcome: null,
    createdAt: '2026-11-09T12:00:00Z',
    deadlineAt: '2026-11-09T12:30:00Z',
    finishedAt: null,
  },
  last: null,
  pendingApprovals: 0,
  pendingHooks: 0,
  notices: { pending: 0, uncertain: 0 },
  ...overrides,
})

it('status shows admissao= instead of fila=', async () => {
  const s = server({ status: { linksRevision: 1, links: [link()] } })
  expect(await run(['orch', 'status'], s.io)).toBe(0)
  expect(s.out()).toBe(
    'exec-api codex serviço ocupado r2/3 d=91c2aaaa-0000-4000-8000-000000000001 3m admissao=bloqueada(d=91c2) aprov=0 hooks=0\n',
  )
  expect(s.out()).not.toContain('fila=')
})

it('status prints the whole dispatchId in d= and cancel accepts it', async () => {
  const s = server({ status: { linksRevision: 1, links: [link()] } })
  await run(['orch', 'status'], s.io)
  const id = / d=([0-9a-f-]{36}) /.exec(s.out())?.[1] as string
  const c = server()
  expect(await run(['orch', 'cancel', '--id', id], c.io)).toBe(0)
  expect(c.out()).toBe('despacho 91c2 cancelado\n')
})

it('status adds avisos=talvez(N) only when notices.uncertain is above zero', async () => {
  const uncertain = link({ notices: { pending: 1, uncertain: 2 } })
  const s = server({ status: { linksRevision: 1, links: [uncertain, link()] } })
  await run(['orch', 'status'], s.io)
  const [a, b] = s.out().trimEnd().split('\n')
  expect(a).toContain(' hooks=0 avisos=talvez(2)')
  expect(b).not.toContain('avisos=')
})

it('status help points to -o json and never to --json', async () => {
  const s = server()
  await run(['orch', 'status', '--help'], s.io)
  expect(s.out()).toContain('-o json')
  expect(s.out()).not.toContain('--json')
})

it('status shows a free executor and the willWait case', async () => {
  const idle = link({ health: 'ready', admission: free, current: null })
  const waiting = link({
    health: 'starting',
    admission: { ...free, willWait: true },
    current: null,
    title: 'exec-b',
  })
  const s = server({ status: { linksRevision: 1, links: [idle, waiting] } })
  await run(['orch', 'status'], s.io)
  const [a, b] = s.out().trimEnd().split('\n')
  expect(a).toBe('exec-api codex serviço livre r2/3 d=- admissao=livre aprov=0 hooks=0')
  expect(b).toBe('exec-b codex serviço iniciando r2/3 d=- admissao=espera aprov=0 hooks=0')
})

it('status --to forwards the target and -o json keeps the raw result', async () => {
  const s = server({ status: { linksRevision: 1, links: [link()] } })
  expect(await run(['orch', 'status', '--to', 'exec-api', '-o', 'json'], s.io)).toBe(0)
  expect(s.bodies[0].payload).toEqual({ to: 'exec-api' })
  expect(JSON.parse(s.out()).links[0].admission.canDispatch).toBe(false)
})

it('spawn sends a request id and prints the link and the first dispatch', async () => {
  const s = server()
  expect(await run(['orch', 'spawn', '--provider', 'codex', '--prompt', 'do it'], s.io)).toBe(0)
  expect(s.bodies[0].payload).toMatchObject({ provider: 'codex', prompt: 'do it' })
  expect(s.bodies[0].payload.requestId).toMatch(/^[0-9a-f-]{36}$/)
  expect(s.out()).toBe('exec-api ligado (codex, serviço); despacho 7f3a aceito, rodada 1/3\n')
})

it('cancel, interrupt and close print the ADR lines', async () => {
  const c = server()
  expect(await run(['orch', 'cancel', '--id', ID], c.io)).toBe(0)
  expect(c.out()).toBe('despacho 91c2 cancelado\n')
  const i = server()
  await run(['orch', 'interrupt', '--to', 'exec-api'], i.io)
  expect(i.out()).toBe('interrupção pedida em exec-api\n')
  const k = server()
  await run(['orch', 'close', '--to', 'exec-api', '--force'], k.io)
  expect(k.bodies[0].payload).toEqual({ to: 'exec-api', force: true })
  expect(k.out()).toBe('exec-api desligado, conversa arquivada\n')
})

it('user-only commands forward their inputs', async () => {
  const s = server()
  await run(['orch', 'link', 'create', '--orchestrator', 'o', '--executor', 'e'], s.io)
  await run(['orch', 'link', 'extend', '--link', ID, '--rounds', '2', '--reason', 'more'], s.io)
  await run(
    ['orch', 'approval', 'respond', '--to', 'e', '--request', 'r1', '--decision', 'accept'],
    s.io,
  )
  await run(['orch', 'hooks', 'approve', '--to', 'e', '--key', 'a', '--key', 'b'], s.io)
  expect(s.bodies.map(b => [b.id, b.payload])).toEqual([
    ['orch.link.create', { orchestratorNodeId: 'o', executorNodeId: 'e' }],
    ['orch.link.extend', { linkId: ID, rounds: 2, reason: 'more' }],
    ['orch.approval.respond', { executorNodeId: 'e', requestId: 'r1', decision: 'accept' }],
    ['orch.hooks.approve', { executorNodeId: 'e', keys: ['a', 'b'] }],
  ])
})

it('spawn defaults the provider to codex and approval respond requires a decision', async () => {
  const s = server()
  expect(await run(['orch', 'spawn'], s.io)).toBe(0)
  expect(s.bodies[0].payload.provider).toBe('codex')
  const a = server()
  expect(await run(['orch', 'approval', 'respond', '--to', 'e', '--request', 'r1'], a.io)).toBe(2)
  expect(a.fetch).not.toHaveBeenCalled()
})
