// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createCodexHookTrustConfiguration,
  resolveCodexHookTrust,
} from '../../../src/contexts/agent/infrastructure/providers/codex/CodexHookTrustResolver'

const command = 'node relay.js'
const hook = (overrides: Record<string, unknown> = {}) => ({
  command,
  handlerType: 'command',
  isManaged: false,
  source: 'sessionFlags',
  currentHash: 'sha256:abc',
  key: 'k:1',
  enabled: true,
  ...overrides,
})

describe('codex hook trust null reasons', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  function captureLog(): () => string {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    return () => stderr.mock.calls.map(call => String(call[0])).join('')
  }

  it('logs the counts when no registered hook matches', () => {
    const log = captureLog()
    const response = { data: [{ hooks: [hook({ command: 'other' }), hook({ source: 'user' })] }] }
    expect(createCodexHookTrustConfiguration(response, command)).toBeNull()
    expect(log()).toContain('no session hook matched')
    expect(log()).toContain('2 hooks listed')
  })

  it('logs a disabled hook', () => {
    const log = captureLog()
    const response = { data: [{ hooks: [hook({ enabled: false }), hook({ key: 'k:2' })] }] }
    expect(createCodexHookTrustConfiguration(response, command)).toBeNull()
    expect(log()).toContain('hook disabled')
    expect(log()).toContain('1 of 2')
  })

  it('logs a count mismatch between matched and trusted entries', () => {
    const log = captureLog()
    const response = { data: [{ hooks: [hook(), hook({ key: "bad'''key", currentHash: 'h' })] }] }
    expect(createCodexHookTrustConfiguration(response, command)).toBeNull()
    expect(log()).toMatch(/count mismatch.*2 matched.*1 trusted/)
  })

  it('logs the process error and still returns null', async () => {
    const log = captureLog()
    const result = await resolveCodexHookTrust({
      clientVersion: '0.0.0',
      executable: '/nonexistent/codex-binary',
      hookCommand: command,
      hookConfigurations: [],
      workspaceDirectory: '/tmp',
    })
    expect(result).toBeNull()
    expect(log()).toContain('hook trust unavailable')
  })

  it('stays silent when trust resolves', () => {
    const log = captureLog()
    expect(createCodexHookTrustConfiguration({ data: [{ hooks: [hook()] }] }, command)).toContain(
      'hooks.state=',
    )
    expect(log()).toBe('')
  })
})
