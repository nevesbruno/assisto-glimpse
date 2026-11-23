// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  EXECUTOR_REMOTE_TOKEN_ENV,
  buildCodexRemoteTuiCommand,
} from '../../../../../src/contexts/orchestration/infrastructure/codex/CodexRemoteTuiCommand'

const base = {
  executablePath: '/usr/bin/codex',
  threadId: 'thread-1',
  url: 'ws://127.0.0.1:4555',
  cwd: '/work/executor',
}

describe('buildCodexRemoteTuiCommand', () => {
  it('resumes the thread against the service with the token by variable name', () => {
    const command = buildCodexRemoteTuiCommand(base)
    expect(command.command).toBe('/usr/bin/codex')
    expect(command.args).toEqual([
      'resume',
      'thread-1',
      '--remote',
      'ws://127.0.0.1:4555',
      '--remote-auth-token-env',
      'OPENCOVE_EXECUTOR_REMOTE_TOKEN',
      '-C',
      '/work/executor',
    ])
    expect(EXECUTOR_REMOTE_TOKEN_ENV).toBe('OPENCOVE_EXECUTOR_REMOTE_TOKEN')
  })

  it('carries no trust override, no own CODEX_HOME and no token text', () => {
    const joined = buildCodexRemoteTuiCommand(base).args.join(' ')
    expect(buildCodexRemoteTuiCommand(base).args).not.toContain('-c')
    expect(joined).not.toContain('trust_level')
    expect(joined).not.toContain('CODEX_HOME')
  })

  it('refuses an endpoint outside loopback ws', () => {
    expect(() => buildCodexRemoteTuiCommand({ ...base, url: 'ws://10.0.0.2:4555' })).toThrow()
    expect(() => buildCodexRemoteTuiCommand({ ...base, url: 'http://127.0.0.1:4555' })).toThrow()
  })
})
