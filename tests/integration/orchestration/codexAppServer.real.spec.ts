// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { CodexJsonRpcClient } from '../../../src/contexts/orchestration/infrastructure/codex/CodexJsonRpcClient'
import {
  startCodexAppServer,
  type CodexAppServerProcess,
} from '../../../src/contexts/orchestration/infrastructure/codex/CodexAppServerProcess'
import { buildCodexProcessEnv } from '../../../src/contexts/orchestration/infrastructure/codex/codexProcessEnv'

/**
 * Opt in with OPENCOVE_TEST_REAL_CODEX=1 (executable from OPENCOVE_TEST_CODEX_BIN, default `codex`).
 * Uses a temporary CODEX_HOME, never ~/.codex, and never starts a turn (no model cost).
 */
const enabled = process.env.OPENCOVE_TEST_REAL_CODEX === '1'

function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

describe.skipIf(!enabled)('codex app-server real process (opt-in)', () => {
  let home = ''
  let cwd = ''
  let service: CodexAppServerProcess

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'glimpse-codex-home-'))
    cwd = await mkdtemp(join(tmpdir(), 'glimpse-codex-cwd-'))
    service = await startCodexAppServer(
      {
        executablePath: process.env.OPENCOVE_TEST_CODEX_BIN ?? 'codex',
        cwd,
        env: buildCodexProcessEnv(process.env, { CODEX_HOME: home }),
        hookTrust: [],
      },
      { reserveLoopbackPort },
    )
  }, 60_000)

  afterAll(async () => {
    await service?.close()
    await rm(home, { recursive: true, force: true })
    await rm(cwd, { recursive: true, force: true })
  })

  it('answers /readyz with 200', async () => {
    const response = await fetch(`http://127.0.0.1:${service.port}/readyz`)
    expect(response.status).toBe(200)
  })

  it('passes initialize with the capability token', async () => {
    const client = new CodexJsonRpcClient({ url: service.url, token: service.token })
    try {
      await expect(client.connect()).resolves.toMatch(/\S/)
    } finally {
      await client.close()
    }
  })

  it('refuses a connection with the wrong token', async () => {
    const client = new CodexJsonRpcClient({ url: service.url, token: 'not-the-token' })
    await expect(client.connect()).rejects.toMatchObject({ code: 'executor.start_failed' })
    await client.close()
  })

  it('refuses a connection without token', async () => {
    const outcome = await new Promise<string>(resolve => {
      const socket = new WebSocket(service.url)
      socket.once('open', () => {
        socket.close()
        resolve('open')
      })
      socket.once('error', error => resolve(error.message))
    })
    expect(outcome).toContain('401')
  })
})
