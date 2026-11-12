import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect } from '@playwright/test'
import { createTestUserDataDir } from './workspace-canvas.testUtils'
import { seedWorkspaceState } from './workspace-canvas.helpers'

export { hashProfileFiles, personalCodexHome } from './orchestration.smoke.helpers'
export { cli } from './agent.prompt.real-codex.helpers'

const appPath = path.resolve(__dirname, '../../')

/** The CLI name the Codex hands to the fake API as a shell tool; the fake never calls a model. */
const apiKeyValue = 'opencove-local-diagnostic-not-a-real-key'

export const realCodexEnabled = (): boolean => process.env['OPENCOVE_TEST_REAL_CODEX'] === '1'
export const realClaudeEnabled = (): boolean => process.env['OPENCOVE_TEST_REAL_CLAUDE'] === '1'

// ---------------------------------------------------------------------------------------------
// Scripted fake Responses API. One endpoint serves the orchestrator and the executors; the role
// comes from the markers in the latest user message (never from a model).
//   orchestrator turn : "ORCH_SPAWN alpha:SLEEP=5 beta:SLEEP=5" or the "[glimpse]" notice
//   executor turn     : "EXEC_TASK <label> [SLEEP=<s>] [OUTSIDE=<file>] [HOOKED]"
// ---------------------------------------------------------------------------------------------

type InputItem = {
  type?: string
  role?: string
  output?: unknown
  arguments?: string
  content?: Array<{ type: string; text?: string }>
}
type ResponsesRequest = { tools?: Array<{ name?: string }>; input?: InputItem[] }

export interface RecordedRequest {
  role: 'orchestrator' | 'executor' | 'other'
  /** Executor label or `notice` for the orchestrator notice turn. */
  label: string
  userText: string
  /** True when the request continues a tool call instead of starting a turn. */
  resumed: boolean
  /** The shell command of the last tool call the fake answered for this conversation. */
  lastToolCommand: string
  lastToolOutput: string
  at: number
}

function userTextOf(body: ResponsesRequest): string {
  const items = (body.input ?? []).filter(item => item.type === 'message' && item.role === 'user')
  return (items.at(-1)?.content ?? []).map(block => block.text ?? '').join('\n')
}

function trailingOutputs(body: ResponsesRequest): string[] {
  const items = body.input ?? []
  const lastUser = items.map(item => item.role === 'user').lastIndexOf(true)
  return items
    .slice(lastUser + 1)
    .filter(item => item.type === 'function_call_output')
    .map(item => (typeof item.output === 'string' ? item.output : JSON.stringify(item.output)))
}

function lastCommandOf(body: ResponsesRequest): string {
  const items = body.input ?? []
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item.type !== 'function_call' || typeof item.arguments !== 'string') {
      continue
    }
    try {
      const parsed = JSON.parse(item.arguments) as { cmd?: unknown }
      return typeof parsed.cmd === 'string' ? parsed.cmd : ''
    } catch {
      return ''
    }
  }
  return ''
}

const shell = (cmd: string, extra: Record<string, unknown> = {}) => ({
  type: 'function_call',
  id: `fc_${Math.random().toString(36).slice(2)}`,
  call_id: `call_${Math.random().toString(36).slice(2)}`,
  name: 'exec_command',
  status: 'completed',
  arguments: JSON.stringify({ cmd, ...extra }),
})

const say = (text: string) => ({
  type: 'message',
  id: `msg_${Math.random().toString(36).slice(2)}`,
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text, annotations: [] }],
})

function orchestratorStep(userText: string, steps: number): ReturnType<typeof say> {
  const spawn = userText.match(/ORCH_SPAWN (.+)/)?.[1]
  if (spawn) {
    const labels = spawn.split(/\s+/).filter(Boolean)
    if (steps < labels.length) {
      const [label, ...flags] = labels[steps].split(':')
      const task = `EXEC_TASK ${label} ${flags.join(' ')}`.trim()
      return shell(
        `opencove orch spawn --provider codex --title "${label}" --prompt "${task}"`,
      ) as never
    }
    return say('ORCH_WAITING')
  }
  const reads = [...userText.matchAll(/ler: (opencove agent read --node (.+?) --turn \S+)/g)]
  if (steps < reads.length) {
    return shell(reads[steps][1]) as never
  }
  if (steps < reads.length * 2) {
    return shell(`opencove orch close --to "${reads[steps - reads.length][2]}"`) as never
  }
  return say('ORCH_DONE')
}

function executorStep(
  userText: string,
  steps: number,
  barrierDir: string | null,
): ReturnType<typeof say> {
  const label = userText.match(/EXEC_TASK (\S+)/)?.[1] ?? 'unknown'
  if (steps === 0) {
    const sleep = userText.match(/SLEEP=(\d+)/)?.[1]
    const outside = userText.match(/OUTSIDE=(\S+)/)?.[1]
    if (sleep) {
      return shell(`sleep ${sleep}`) as never
    }
    if (outside) {
      return shell(`touch ${outside}`, {
        sandbox_permissions: 'require_escalated',
        justification: 'Create the approval probe file',
      }) as never
    }
    if (userText.includes('HOOKED')) {
      return shell('echo hooked') as never
    }
    if (barrierDir && userText.includes('BARRIER')) {
      // Both executors finish at the same moment, so the notice pump aggregates them in one batch.
      const dir = shellQuote(path.join(barrierDir, 'barrier'))
      return shell(
        `mkdir -p ${dir} && touch ${shellQuote(path.join(barrierDir, 'barrier', label))} && i=0; while [ "$(ls ${dir} | wc -l)" -lt 2 ] && [ "$i" -lt 600 ]; do sleep 0.1; i=$((i+1)); done`,
      ) as never
    }
  }
  return say(`EXEC_DONE ${label}`)
}

function writeSse(res: ServerResponse, item: object): void {
  const id = `resp_${Date.now()}`
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const send = (type: string, data: Record<string, unknown>) =>
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
  send('response.created', { response: { id, status: 'in_progress', output: [] } })
  send('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress' } })
  send('response.output_item.done', { output_index: 0, item })
  send('response.completed', {
    response: {
      id,
      status: 'completed',
      output: [item],
      usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 },
    },
  })
  res.end()
}

export interface OrchestrationApi {
  server: Server
  url: string
  requests: () => RecordedRequest[]
}

export async function startOrchestrationApi(
  barrierDir: string | null = null,
): Promise<OrchestrationApi> {
  const recorded: RecordedRequest[] = []
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      chunks.push(chunk as Buffer)
    }
    let body: ResponsesRequest | null = null
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ResponsesRequest
    } catch {
      body = null
    }
    if (!(req.method === 'POST' && (req.url ?? '').includes('/responses') && body)) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
      return
    }
    const isMain = (body.tools ?? []).some(tool => tool.name === 'exec_command')
    const userText = userTextOf(body)
    const outputs = trailingOutputs(body)
    const orchestrator = userText.includes('ORCH_SPAWN') || userText.includes('[glimpse]')
    const executor = userText.includes('EXEC_TASK')
    const role = !isMain ? 'other' : executor ? 'executor' : orchestrator ? 'orchestrator' : 'other'
    const label =
      role === 'executor'
        ? (userText.match(/EXEC_TASK (\S+)/)?.[1] ?? '')
        : userText.includes('[glimpse]')
          ? 'notice'
          : ''
    recorded.push({
      role,
      label,
      userText,
      resumed: outputs.length > 0,
      lastToolCommand: lastCommandOf(body),
      lastToolOutput: outputs.at(-1) ?? '',
      at: Date.now(),
    })
    const item =
      role === 'executor'
        ? executorStep(userText, outputs.length, barrierDir)
        : role === 'orchestrator'
          ? orchestratorStep(userText, outputs.length)
          : say('ACK')
    writeSse(res, item)
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const { port } = server.address() as AddressInfo
  return { server, url: `http://127.0.0.1:${port}/v1`, requests: () => [...recorded] }
}

// ---------------------------------------------------------------------------------------------
// Fixture: temporary workspace, a `codex` wrapper that points the personal profile at the fake
// API through `-c` flags (nothing is written under ~/.codex), and the Electron launch.
// ---------------------------------------------------------------------------------------------

export interface RealCodexFixture {
  root: string
  workspace: string
  wrapperDir: string
  api: OrchestrationApi
  /** Extra `-c key=value` pairs the wrapper adds to every Codex process it launches. */
  extraConfig: string[]
  dispose: () => Promise<void>
}

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`

export async function createFixture(extraConfig: string[] = []): Promise<RealCodexFixture> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'opencove-orch-real-')))
  const workspace = path.join(root, 'workspace')
  const wrapperDir = path.join(root, 'bin')
  await Promise.all([mkdir(workspace), mkdir(wrapperDir)])
  const api = await startOrchestrationApi(root)
  const realCodex = execFileSync('which', ['codex'], { encoding: 'utf8' }).trim()
  const provider = `model_providers.mock={name="mock",base_url="${api.url}",wire_api="responses",env_key="GLIMPSE_TEST_MOCK_API_KEY"}`
  const overrides = [
    'model_provider="mock"',
    'model="test-model"',
    'check_for_update_on_startup=false',
    // The personal profile inherits only the core environment; the CLI shim needs OPENCOVE_*.
    'shell_environment_policy.inherit="all"',
    provider,
    ...extraConfig,
  ]
  const script = [
    '#!/bin/sh',
    `exec ${shellQuote(realCodex)} ${overrides.map(entry => `-c ${shellQuote(entry)}`).join(' ')} "$@"`,
    '',
  ].join('\n')
  const wrapperPath = path.join(wrapperDir, 'codex')
  await writeFile(wrapperPath, script)
  await chmod(wrapperPath, 0o755)
  // The app resolves `claude` from PATH; the personal hardening shim needs the real HOME, so the
  // wrapper dir shadows it with the real binary instead of an executable override setting.
  const realClaude = path.join(process.env['HOME'] ?? '', '.local/bin/claude')
  if (existsSync(realClaude)) {
    await symlink(realClaude, path.join(wrapperDir, 'claude'))
  }
  return {
    root,
    workspace,
    wrapperDir,
    api,
    extraConfig,
    dispose: async () => {
      await new Promise<void>(done => api.server.close(() => done()))
      await rm(root, { recursive: true, force: true }).catch(() => undefined)
    },
  }
}

export interface LaunchedApp {
  electronApp: ElectronApplication
  window: Page
  userDataDir: string
  pid: number
  stderr: () => string
}

/** Launches the built app on `userDataDir` (reused on restart); CODEX_HOME stays the personal one. */
export async function launchRealCodexApp(
  fixture: RealCodexFixture,
  userDataDir?: string,
  extraEnv: Record<string, string> = {},
): Promise<LaunchedApp> {
  const dataDir = userDataDir ?? (await createTestUserDataDir())
  const dirs = ['home', 'config', 'cache', 'runtime'].map(name => path.join(dataDir, name))
  await Promise.all(dirs.map(dir => mkdir(dir, { recursive: true, mode: 0o700 })))
  const [home, config, cache, runtime] = dirs
  const baseEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === 'string' &&
        entry[0] !== 'ELECTRON_RUN_AS_NODE' &&
        entry[0] !== '__CFBundleIdentifier' &&
        entry[0] !== 'OPENCOVE_TEST_USE_REAL_AGENTS',
    ),
  )
  const electronApp = await electron.launch({
    timeout: 60_000,
    args: [appPath],
    env: {
      ...baseEnv,
      NODE_ENV: 'test',
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: config,
      XDG_CACHE_HOME: cache,
      XDG_RUNTIME_DIR: runtime,
      CODEX_HOME: process.env['CODEX_HOME'] ?? path.join(process.env['HOME'] ?? '', '.codex'),
      PATH: `${fixture.wrapperDir}${path.delimiter}${process.env['PATH'] ?? ''}`,
      OPENCOVE_TEST_WORKSPACE: fixture.workspace,
      OPENCOVE_TEST_USER_DATA_DIR: dataDir,
      OPENCOVE_TEST_NODE_EXECUTABLE: process.execPath,
      OPENCOVE_TEST_USE_REAL_AGENTS: '1',
      OPENCOVE_TEST_CODEX_HOOK_INSTALL_FAILURE: '0',
      OPENCOVE_TEST_MOCK_API_KEY: apiKeyValue,
      // Neutral name: the executor service strips every OPENCOVE_* variable.
      GLIMPSE_TEST_MOCK_API_KEY: apiKeyValue,
      OPENCOVE_E2E_FORCE_RENDERER_SANDBOX: '1',
      OPENCOVE_E2E_WINDOW_MODE: process.env['OPENCOVE_E2E_WINDOW_MODE'] ?? 'offscreen',
      ...extraEnv,
    },
  })
  let stderr = ''
  electronApp.process().stderr?.on('data', chunk => {
    stderr += String(chunk)
  })
  const window = await electronApp.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  return {
    electronApp,
    window,
    userDataDir: dataDir,
    pid: electronApp.process().pid!,
    stderr: () => stderr,
  }
}

export const orchestratorWorkspaceId = 'orch-real'
export const orchestratorSpaceId = 'orch-space'
export const orchestratorNodeId = 'orch-agent'

/**
 * Seeds one task whose requirement is the orchestrator script and runs it as a Codex agent.
 * The task and the orchestrator agent sit inside a space: `createExecutorNode` refuses an
 * orchestrator outside any space (B1), so seeding one is what lets `orch spawn` work.
 */
export async function startOrchestrator(
  app: LaunchedApp,
  fixture: RealCodexFixture,
  script: string,
  options: { fullAccess: boolean },
): Promise<{ nodeId: string; sessionId: string; runState: () => Promise<string> }> {
  const { window } = app
  const directory = {
    executionDirectory: fixture.workspace,
    expectedDirectory: fixture.workspace,
    directoryMode: 'workspace' as const,
    customDirectory: null,
    shouldCreateDirectory: false,
  }
  await seedWorkspaceState(window, {
    activeWorkspaceId: orchestratorWorkspaceId,
    settings: {
      defaultProvider: 'claude-code',
      agentFullAccess: options.fullAccess,
      customModelEnabledByProvider: { codex: false },
    },
    workspaces: [
      {
        id: orchestratorWorkspaceId,
        name: 'Orchestration real',
        path: fixture.workspace,
        nodes: [
          {
            id: 'orch-task',
            title: 'Orchestrator task',
            kind: 'task',
            status: null,
            position: { x: 100, y: 80 },
            width: 460,
            height: 280,
            task: {
              requirement: script,
              status: 'todo',
              linkedAgentNodeId: orchestratorNodeId,
              lastRunAt: null,
              autoGeneratedTitle: false,
            },
          },
          {
            id: orchestratorNodeId,
            title: 'Orchestrator task',
            kind: 'agent',
            status: null,
            startedAt: null,
            endedAt: null,
            exitCode: null,
            lastError: null,
            position: { x: 640, y: 80 },
            width: 460,
            height: 300,
            ...directory,
            agent: {
              provider: 'claude-code',
              prompt: script,
              model: null,
              effectiveModel: null,
              launchMode: 'new',
              resumeSessionId: null,
              ...directory,
            },
          },
        ],
        spaces: [
          {
            id: orchestratorSpaceId,
            name: 'Orchestration space',
            directoryPath: fixture.workspace,
            nodeIds: ['orch-task', orchestratorNodeId],
            rect: { x: 60, y: 40, width: 1040, height: 760 },
          },
        ],
      },
    ],
  })
  await window.locator('[data-testid="task-node-run-agent"]').click()
  const sessionIdOf = async () =>
    await window.evaluate(nodeId => {
      const harness = (
        window as Window & {
          __opencoveWorkspaceCanvasTestApi?: {
            getAgentSessions: () => Array<{ nodeId: string; sessionId: string }>
          }
        }
      ).__opencoveWorkspaceCanvasTestApi
      return harness?.getAgentSessions().find(session => session.nodeId === nodeId)?.sessionId ?? ''
    }, orchestratorNodeId)
  await expect.poll(sessionIdOf, { timeout: 60_000, message: 'orchestrator session' }).not.toBe('')
  const sessionId = await sessionIdOf()
  const run = async () =>
    await window.evaluate(
      id =>
        window.opencoveApi.controlSurface.invoke<{ nodeId: string | null; state: string } | null>({
          kind: 'query',
          id: 'agent.get',
          payload: { sessionId: id },
        }),
      sessionId,
    )
  return {
    nodeId: orchestratorNodeId,
    sessionId,
    runState: async () => (await run())?.state ?? 'unknown',
  }
}
