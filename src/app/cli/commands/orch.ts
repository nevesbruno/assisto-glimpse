import { randomUUID } from 'node:crypto'
import { defineCommand, type Command, type CommandContext, type OptionSpec } from '../core/command'
import { CliError, usage, validationError } from '../core/errors'
import { getControlSurfaceOperation } from '../../../shared/contracts/controlSurface/operations'
import { declaredOutput } from './declaredOutput'
import { stringOption } from './nodes'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const short = (id: unknown) => String(id ?? '?').slice(0, 4)

const target = (description: string): OptionSpec => ({
  type: 'string',
  valueName: 'node',
  required: true,
  description,
})
const toOption = target('Executor node title or ID linked to you')
const dispatchIdOption = (description: string, required = false): OptionSpec => ({
  type: 'string',
  valueName: 'dispatchId',
  required,
  description,
})

function requireUuid(flag: string, value: unknown) {
  if (typeof value !== 'string' || !UUID.test(value)) {
    usage(
      `--${flag} must be a dispatch ID (UUID).`,
      'Reuse the dispatchId printed by orch dispatch.',
    )
  }
  return value
}

type Admission = {
  canDispatch: boolean
  reason: string | null
  blocking: { dispatchId: string } | null
  willWait: boolean
}
type StatusLink = {
  title: string
  provider: string
  runtimeMode: string
  health: string
  roundsUsed: number
  roundsLimit: number
  admission: Admission
  current: { dispatchId: string; createdAt: string } | null
  notices: { uncertain: number }
  pendingApprovals: number
  pendingHooks: number
}

const healthLabel: Record<string, string> = {
  starting: 'iniciando',
  ready: 'livre',
  busy: 'ocupado',
  degraded: 'degradado',
  unavailable: 'indisponível',
}

function age(createdAt: string) {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(createdAt)) / 1000))
  return seconds < 60
    ? `${seconds}s`
    : seconds < 3600
      ? `${Math.floor(seconds / 60)}m`
      : `${Math.floor(seconds / 3600)}h`
}

function admissionLabel(admission: Admission) {
  if (admission.canDispatch) {
    return admission.willWait ? 'espera' : 'livre'
  }
  return `bloqueada(${admission.blocking ? `d=${short(admission.blocking.dispatchId)}` : admission.reason})`
}

function statusLine(link: StatusLink) {
  const { current } = link
  return [
    link.title,
    link.provider,
    link.runtimeMode === 'service' ? 'serviço' : link.runtimeMode,
    healthLabel[link.health] ?? link.health,
    `r${link.roundsUsed}/${link.roundsLimit}`,
    ...(current ? [`d=${current.dispatchId}`, age(current.createdAt)] : ['d=-']),
    `admissao=${admissionLabel(link.admission)}`,
    `aprov=${link.pendingApprovals}`,
    `hooks=${link.pendingHooks}`,
    ...(link.notices.uncertain > 0 ? [`avisos=talvez(${link.notices.uncertain})`] : []),
  ].join(' ')
}

const line = (text: string) => `${text}\n`
const field = <T>(result: unknown) => result as T

async function dispatch(ctx: CommandContext) {
  const options = ctx.options
  const dispatchId = options.id === undefined ? randomUUID() : requireUuid('id', options.id)
  const text =
    options.file === undefined ? options.text : await readTaskFile(ctx, String(options.file))
  const payload = { dispatchId, to: options.to, text }
  const operation = getControlSurfaceOperation('orch.dispatch')
  if (operation?.contract === 'schema') {
    const parsed = operation.input.safeParse(payload)
    if (!parsed.success) {
      throw validationError('orch.dispatch', parsed.error.issues, 2, 'cli.usage', payload)
    }
  }
  ctx.io.stderr.write(
    `Dispatch ID: ${dispatchId}. After a timeout, check opencove orch status or reuse it with --id; never resend the text blindly.\n`,
  )
  try {
    const result = await ctx.invoke('orch.dispatch', payload)
    return { ...(result as object), to: options.to }
  } catch (error) {
    throw error instanceof CliError && error.code === 'orch.dispatch_in_flight'
      ? inFlightRefusal(error, String(options.to))
      : error
  }
}

async function readTaskFile(ctx: CommandContext, path: string) {
  try {
    return path === '-' ? await ctx.io.readStdinText() : await ctx.io.readTextFile(path)
  } catch (error) {
    if (error instanceof CliError && error.exitCode === 130) {
      throw error
    }
    return usage(`Unable to read --file: ${path}. Nothing was sent.`)
  }
}

function inFlightRefusal(error: CliError, to: string) {
  const blocking = field<{ dispatchId?: string; state?: string; round?: number }>(
    error.details ?? {},
  )
  return new CliError(
    error.code,
    1,
    `recusado: despacho ${short(blocking.dispatchId)} de ${to} em andamento (${blocking.state}, rodada ${blocking.round}); aguarde o aviso`,
    'Wait for the notice, or fix it with orch cancel (queued) or orch interrupt (sent). opencove orch status shows the admission.',
    error.details,
  )
}

const dispatchCommand = defineCommand({
  path: ['orch', 'dispatch'],
  connect: true,
  operation: 'orch.dispatch',
  serverValidation: true,
  usage: '--to <node> (--text <text> | --file <path|->) [--id <dispatchId>]',
  summary: 'Queue a task for a linked executor',
  description: [
    'Send a task to an executor linked to you. Use exactly one of --text or --file (- reads stdin). The dispatchId is printed to stderr before the Worker is called.',
    'Each executor holds one open dispatch at a time. Check opencove orch status first: with admission blocked, wait for the notice. A refused dispatch names the dispatch that is still waiting.',
    'After a timeout (exit 124) run opencove orch status, or retry with --id <dispatchId> from the first attempt. The same ID never creates a second dispatch.',
    'Exit codes: 0 accepted; 1 refused (orch.dispatch_in_flight, orch.round_limit_reached, orch.not_linked); 2 invalid input; 124 deadline, the dispatch may still have been accepted; 130 interruption.',
  ].join('\n\n'),
  options: {
    to: toOption,
    text: {
      type: 'string',
      valueName: 'text',
      description: 'Task text; use this or --file',
      conflicts: ['file'],
    },
    file: {
      type: 'string',
      valueName: 'path',
      description: 'Read the task text from a UTF-8 file, or - for stdin',
      conflicts: ['text'],
    },
    id: dispatchIdOption('Reuse this dispatchId, for example the one printed before a timeout'),
  },
  examples: [
    'opencove orch dispatch --to exec-api --text "Add the retry test"',
    'opencove orch dispatch --to exec-api --file ./task.md',
    'opencove orch dispatch --to exec-api --text "Add the retry test" --id 91c2f3a0-0000-4000-8000-000000000001',
  ],
  render: declaredOutput(
    ['dispatchId', 'state', 'round', 'roundsLimit', 'duplicate', 'admission', 'to'],
    { dispatchId: 'd' },
  ),
  buildInput: ({ options }) => {
    if ((options.text === undefined) === (options.file === undefined)) {
      usage(
        'Provide the task with exactly one of --text or --file.',
        'Use --file - to read from stdin.',
      )
    }
    if (options.id !== undefined) {
      requireUuid('id', options.id)
    }
    return null
  },
  execute: dispatch,
  textOutput: result => {
    const r = field<{
      dispatchId: string
      to: string
      state: string
      round: number
      roundsLimit: number
      duplicate?: boolean
    }>(result)
    return line(
      r.duplicate
        ? `despacho ${short(r.dispatchId)} já registrado em ${r.to} (${r.state}), rodada ${r.round}/${r.roundsLimit}; aguarde o aviso`
        : `despacho ${short(r.dispatchId)} aceito para ${r.to}, rodada ${r.round}/${r.roundsLimit}; aguarde o aviso antes de enviar o próximo`,
    )
  },
})

const spawnCommand = defineCommand({
  path: ['orch', 'spawn'],
  connect: true,
  operation: 'orch.spawn',
  summary: 'Create an executor linked to you, optionally with its first task',
  description:
    'Creates an executor node and links it to the calling orchestrator. With --prompt the first dispatch is queued at once; wait for the notice before dispatching again.',
  options: {
    provider: {
      type: 'string',
      valueName: 'codex',
      choices: ['codex'],
      description: 'Executor provider (default and only value: codex)',
    },
    prompt: {
      type: 'string',
      valueName: 'text',
      description: 'First task for the executor',
      fileVariant: true,
    },
    title: { type: 'string', valueName: 'title', description: 'Title of the new executor node' },
    model: {
      type: 'string',
      valueName: 'model',
      description: 'Model passed to the executor provider',
    },
  },
  examples: ['opencove orch spawn --provider codex --prompt "Add the retry test"'],
  render: declaredOutput(
    ['executorNodeId', 'linkId', 'runtimeMode', 'duplicate', 'dispatch', 'admission'],
    { executorNodeId: 'node-1' },
  ),
  buildInput: ({ options }) => ({
    requestId: randomUUID(),
    provider: options.provider ?? 'codex',
    ...(options.prompt !== undefined ? { prompt: options.prompt } : {}),
    ...(options.title !== undefined ? { title: options.title } : {}),
    ...(options.model !== undefined ? { model: options.model } : {}),
  }),
  textOutput: result => {
    const r = field<{
      executorNodeId: string
      runtimeMode: string
      duplicate: boolean
      dispatch: { dispatchId: string; round: number; roundsLimit: number } | null
    }>(result)
    const mode = r.runtimeMode === 'service' ? 'serviço' : r.runtimeMode
    const head = `${r.executorNodeId} ligado (codex, ${mode})`
    return line(
      r.dispatch
        ? `${head}; despacho ${short(r.dispatch.dispatchId)} aceito, rodada ${r.dispatch.round}/${r.dispatch.roundsLimit}`
        : head,
    )
  },
})

const statusCommand = defineCommand({
  path: ['orch', 'status'],
  connect: true,
  operation: 'orch.status',
  summary: 'Show linked executors with health, rounds and dispatch admission',
  description:
    'One line per executor. admissao= says whether orch dispatch would be accepted now (livre), accepted but delayed (espera) or refused (bloqueada, with the blocking dispatch). Run it before dispatching and after any timeout. Use -o json for the full result.',
  options: { to: { ...toOption, required: false, description: 'Only this executor' } },
  examples: ['opencove orch status', 'opencove orch status --to exec-api -o json'],
  render: declaredOutput(['linksRevision', 'links'], { linksRevision: 1 }),
  buildInput: ({ options }) => (options.to !== undefined ? { to: options.to } : {}),
  textOutput: result => {
    const links = field<{ links: StatusLink[] }>(result).links
    return links.length
      ? links.map(l => line(statusLine(l))).join('')
      : line('nenhum executor ligado')
  },
})

const simple = (
  path: string[],
  operation: 'orch.cancel' | 'orch.interrupt' | 'orch.close',
  summary: string,
  options: Record<string, OptionSpec>,
  buildInput: Command['buildInput'],
  textOutput: (result: unknown, to: string) => string,
  examples: string[],
  fields: string[],
) => {
  const command = defineCommand({
    path,
    connect: true,
    operation,
    summary,
    options,
    examples,
    render: declaredOutput(fields, Object.fromEntries(fields.map(name => [name, 'x']))),
    buildInput,
    async execute(ctx) {
      const result = await ctx.invoke(operation, ctx.input)
      return { ...(result as object), to: ctx.options.to }
    },
    textOutput: result => textOutput(result, String(field<{ to?: string }>(result).to)),
  })
  return command
}

const cancelCommand = simple(
  ['orch', 'cancel'],
  'orch.cancel',
  'Cancel a dispatch that is still queued',
  { id: dispatchIdOption('Dispatch to cancel', true) },
  ({ options }) => ({ dispatchId: requireUuid('id', options.id) }),
  result => line(`despacho ${short(field<{ dispatchId: string }>(result).dispatchId)} cancelado`),
  ['opencove orch cancel --id 91c2f3a0-0000-4000-8000-000000000001'],
  ['dispatchId', 'state'],
)
const interruptCommand = simple(
  ['orch', 'interrupt'],
  'orch.interrupt',
  'Interrupt the running turn of a linked executor',
  { to: toOption },
  ({ options }) => ({ to: options.to }),
  (_result, to) => line(`interrupção pedida em ${to}`),
  ['opencove orch interrupt --to exec-api'],
  ['ok', 'to'],
)
const closeCommand = simple(
  ['orch', 'close'],
  'orch.close',
  'Close the link to an executor and archive its conversation',
  { to: toOption, force: { type: 'boolean', description: 'Close even with a dispatch in flight' } },
  ({ options }) => ({ to: options.to, ...(options.force ? { force: true } : {}) }),
  (_result, to) => line(`${to} desligado, conversa arquivada`),
  ['opencove orch close --to exec-api', 'opencove orch close --to exec-api --force'],
  ['ok', 'to'],
)

const linkId: OptionSpec = {
  type: 'string',
  valueName: 'linkId',
  required: true,
  description: 'Link ID',
}
const force: OptionSpec = { type: 'boolean', description: 'Close even with a dispatch in flight' }
const userOnly = 'User only: needs an admin credential outside the orchestrator session.'

const userCommands: Command[] = [
  defineCommand({
    path: ['orch', 'link', 'create'],
    connect: true,
    operation: 'orch.link.create',
    summary: 'Link an existing executor node to an orchestrator node',
    description: userOnly,
    options: {
      orchestrator: target('Orchestrator node ID'),
      executor: target('Executor node ID'),
    },
    examples: ['opencove orch link create --orchestrator node-1 --executor node-2'],
    render: declaredOutput(['linkId', 'runtimeMode'], { linkId: 'l' }),
    buildInput: ({ options }) => ({
      orchestratorNodeId: options.orchestrator,
      executorNodeId: options.executor,
    }),
  }),
  defineCommand({
    path: ['orch', 'link', 'close'],
    connect: true,
    operation: 'orch.link.close',
    summary: 'Close a link by ID',
    description: userOnly,
    options: { link: linkId, force },
    examples: ['opencove orch link close --link 91c2f3a0-0000-4000-8000-000000000001'],
    render: declaredOutput(['ok'], { ok: true }),
    buildInput: ({ options }) => ({
      linkId: options.link,
      ...(options.force ? { force: true } : {}),
    }),
  }),
  defineCommand({
    path: ['orch', 'link', 'list'],
    connect: true,
    operation: 'orch.link.list',
    summary: 'List orchestration links with the links revision',
    options: { project: stringOption('Project ID') },
    examples: ['opencove orch link list'],
    render: declaredOutput(['linksRevision', 'links'], { linksRevision: 1 }),
    buildInput: ({ options }) => (options.project ? { projectId: options.project } : {}),
  }),
  defineCommand({
    path: ['orch', 'link', 'extend'],
    connect: true,
    operation: 'orch.link.extend',
    summary: 'Grant extra dispatch rounds to a link',
    description: userOnly,
    options: {
      link: linkId,
      rounds: {
        type: 'number',
        valueName: '1|2',
        required: true,
        description: 'Extra rounds, 1 or 2',
      },
      reason: {
        type: 'string',
        valueName: 'text',
        required: true,
        description: 'Why the limit is extended',
      },
    },
    examples: [
      'opencove orch link extend --link 91c2f3a0-0000-4000-8000-000000000001 --rounds 1 --reason "Needs a retry"',
    ],
    render: declaredOutput(['linkId', 'roundsLimit'], { linkId: 'l', roundsLimit: 4 }),
    buildInput: ({ options }) => ({
      linkId: options.link,
      rounds: options.rounds,
      reason: options.reason,
    }),
  }),
  defineCommand({
    path: ['orch', 'approval', 'respond'],
    connect: true,
    operation: 'orch.approval.respond',
    summary: 'Answer a pending executor approval request',
    description: userOnly,
    options: {
      to: toOption,
      request: {
        type: 'string',
        valueName: 'id',
        required: true,
        description: 'Approval request ID',
      },
      decision: {
        type: 'string',
        valueName: 'accept|acceptForSession|decline|cancel',
        choices: ['accept', 'acceptForSession', 'decline', 'cancel'],
        description: 'Decision sent to the executor (required)',
      },
    },
    examples: ['opencove orch approval respond --to exec-api --request req-1 --decision accept'],
    render: declaredOutput(['ok'], { ok: true }),
    buildInput: ({ options }) => {
      if (options.decision === undefined) {
        usage('Missing required option --decision for "opencove orch approval respond".')
      }
      return { executorNodeId: options.to, requestId: options.request, decision: options.decision }
    },
  }),
  defineCommand({
    path: ['orch', 'hooks', 'approve'],
    connect: true,
    operation: 'orch.hooks.approve',
    summary: 'Approve pending executor hooks and restart its service',
    description: userOnly,
    options: {
      to: toOption,
      key: {
        type: 'string',
        valueName: 'key',
        required: true,
        multiple: true,
        description: 'Hook key to approve; repeatable',
      },
    },
    examples: ['opencove orch hooks approve --to exec-api --key hook-a --key hook-b'],
    render: declaredOutput(['approved', 'restart'], { approved: 2, restart: 'scheduled' }),
    buildInput: ({ options }) => ({ executorNodeId: options.to, keys: [options.key].flat() }),
  }),
]

export const orchCommands: Command[] = [
  spawnCommand,
  dispatchCommand,
  statusCommand,
  cancelCommand,
  interruptCommand,
  closeCommand,
  ...userCommands,
]
