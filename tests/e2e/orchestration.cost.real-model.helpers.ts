import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import type { RealCodexFixture } from './orchestration.real-codex.helpers'
import { createTestUserDataDir } from './workspace-canvas.testUtils'

// E-04 harness: one scripted orchestrator (Claude Code over a fake Messages API, zero model cost)
// and two Codex executors. `fake` mode points the executors at a scripted Responses API with known
// usage; `real` mode executes the personal profile untouched and the JSONL rollout is the source
// of truth for tokens.

export type CostMode = 'fake' | 'real'
export type CostExecutor = 'alpha' | 'beta'

export const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`
export const personalCodexHome = (): string =>
  process.env['CODEX_HOME'] ?? path.join(homedir(), '.codex')

interface Usage {
  input: number
  cached: number
  cacheWrite: number
  output: number
}

interface RecordedResponse {
  prompt: string
  usage: Usage
}

export interface CostResponsesApi {
  server: Server
  url: string
  requests: () => RecordedResponse[]
}

const usageFor = (prompt: string): Usage =>
  prompt.includes('E04_ALPHA_2')
    ? { input: 20_500, cached: 20_000, cacheWrite: 0, output: 30 }
    : { input: 20_000, cached: 2_000, cacheWrite: 18_000, output: 30 }

function userTextOf(body: { input?: Array<Record<string, unknown>> }): string {
  const items = (body.input ?? []).filter(item => item.type === 'message' && item.role === 'user')
  const content = (items.at(-1)?.['content'] ?? []) as Array<{ text?: string }>
  return content.map(block => block.text ?? '').join('\n')
}

function writeFakeResponse(res: ServerResponse, text: string, usage: Usage): void {
  const id = `resp_${Date.now()}`
  const item = {
    type: 'message',
    id: `msg_${Date.now()}`,
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }],
  }
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
      usage: {
        input_tokens: usage.input,
        input_tokens_details: {
          cached_tokens: usage.cached,
          cache_write_tokens: usage.cacheWrite,
        },
        output_tokens: usage.output,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: usage.input + usage.output,
        cached_input_tokens: usage.cached,
        cache_write_input_tokens: usage.cacheWrite,
      },
    },
  })
  res.end()
}

/** Scripted Responses API for the fake rehearsal; usage is deterministic per prompt marker. */
export async function startCostResponsesApi(): Promise<CostResponsesApi> {
  const recorded: RecordedResponse[] = []
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      chunks.push(chunk as Buffer)
    }
    let body: { input?: Array<Record<string, unknown>> } | null = null
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        input?: Array<Record<string, unknown>>
      }
    } catch {
      body = null
    }
    if (!(req.method === 'POST' && (req.url ?? '').includes('/responses') && body)) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
      return
    }
    const prompt = userTextOf(body)
    const usage = usageFor(prompt)
    recorded.push({ prompt, usage })
    writeFakeResponse(res, 'E04_FAKE_OK', usage)
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const { port } = server.address() as AddressInfo
  return { server, url: `http://127.0.0.1:${port}/v1`, requests: () => [...recorded] }
}

export interface CostFixture extends RealCodexFixture {
  mode: CostMode
}

/** Temporary workspace plus a `codex` shim: fake mode keeps the mock provider, real mode passes through. */
export async function createCostFixture(mode: CostMode): Promise<CostFixture> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'opencove-orch-cost-')))
  const workspace = path.join(root, 'workspace')
  const wrapperDir = path.join(root, 'bin')
  await Promise.all([mkdir(workspace), mkdir(wrapperDir)])
  const realCodex = execFileSync('which', ['codex'], { encoding: 'utf8' }).trim()
  const fake = mode === 'fake' ? await startCostResponsesApi() : null
  const overrides =
    mode === 'fake' && fake
      ? [
          'model_provider="mock"',
          'model="test-model"',
          'check_for_update_on_startup=false',
          'shell_environment_policy.inherit="all"',
          `model_providers.mock={name="mock",base_url="${fake.url}",wire_api="responses",env_key="GLIMPSE_TEST_MOCK_API_KEY"}`,
        ]
      : []
  const script = [
    '#!/bin/sh',
    `exec ${shellQuote(realCodex)} ${overrides.map(entry => `-c ${shellQuote(entry)}`).join(' ')} "$@"`,
    '',
  ].join('\n')
  const wrapperPath = path.join(wrapperDir, 'codex')
  await writeFile(wrapperPath, script)
  await chmod(wrapperPath, 0o755)
  const realClaude = path.join(process.env['HOME'] ?? '', '.local/bin/claude')
  await symlink(realClaude, path.join(wrapperDir, 'claude')).catch(() => undefined)
  return {
    mode,
    root,
    workspace,
    wrapperDir,
    api: { server: createServer(), url: '', requests: () => [] },
    extraConfig: overrides,
    dispose: async () => {
      if (fake) {
        await new Promise<void>(done => fake.server.close(() => done()))
      }
      await rm(root, { recursive: true, force: true }).catch(() => undefined)
    },
  }
}

export interface CostApp {
  electronApp: ElectronApplication
  window: Page
  userDataDir: string
  pid: number
  stderr: () => string
}

/** Same launch contract as the real-Codex fixture, without the fake model keys. */
export async function launchCostApp(
  fixture: CostFixture,
  userDataDir?: string,
  extraEnv: Record<string, string> = {},
): Promise<CostApp> {
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
        entry[0] !== 'OPENCOVE_TEST_USE_REAL_AGENTS' &&
        entry[0] !== 'OPENCOVE_TEST_REAL_MODEL',
    ),
  )
  const electronApp = await electron.launch({
    timeout: 60_000,
    args: [path.resolve(__dirname, '../../')],
    env: {
      ...baseEnv,
      NODE_ENV: 'test',
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: config,
      XDG_CACHE_HOME: cache,
      XDG_RUNTIME_DIR: runtime,
      CODEX_HOME: personalCodexHome(),
      PATH: `${fixture.wrapperDir}${path.delimiter}${process.env['PATH'] ?? ''}`,
      OPENCOVE_TEST_WORKSPACE: fixture.workspace,
      OPENCOVE_TEST_USER_DATA_DIR: dataDir,
      OPENCOVE_TEST_NODE_EXECUTABLE: process.execPath,
      OPENCOVE_TEST_USE_REAL_AGENTS: '1',
      OPENCOVE_TEST_CODEX_HOOK_INSTALL_FAILURE: '0',
      OPENCOVE_TEST_MOCK_API_KEY: 'opencove-local-diagnostic-not-a-real-key',
      GLIMPSE_TEST_MOCK_API_KEY: 'opencove-local-diagnostic-not-a-real-key',
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

export {
  appServerPidsUnder,
  buildCostReport,
  findRolloutFile,
  parseRollout,
  readGlimpseThreads,
  type CodexThreadRow,
  type CostNotice,
  type CostReport,
  type CostReportTurn,
  type ParsedRollout,
  type ParsedTurn,
  type TurnUsage,
} from './orchestration.cost.real-model.tokens'
export {
  startCostOrchestratorApi,
  type CostOrchestratorApi,
} from './orchestration.cost.real-model.orchestrator'
