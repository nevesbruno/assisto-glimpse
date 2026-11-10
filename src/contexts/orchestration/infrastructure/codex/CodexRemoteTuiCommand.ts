export const EXECUTOR_REMOTE_TOKEN_ENV = 'OPENCOVE_EXECUTOR_REMOTE_TOKEN'

const LOOPBACK_WS_URL = /^ws:\/\/127\.0\.0\.1:\d+$/

export interface CodexRemoteTuiInput {
  readonly executablePath: string
  readonly threadId: string
  readonly url: string
  readonly cwd: string
}

/**
 * The TUI only follows the service: folder trust is decided by the server (V2), so no `-c` and
 * no own CODEX_HOME. The token travels by variable name, never as text.
 */
export function buildCodexRemoteTuiCommand(input: CodexRemoteTuiInput): {
  command: string
  args: string[]
} {
  if (!LOOPBACK_WS_URL.test(input.url)) {
    throw new Error('Executor TUI endpoint must be a loopback ws URL.')
  }
  return {
    command: input.executablePath,
    args: [
      'resume',
      input.threadId,
      '--remote',
      input.url,
      '--remote-auth-token-env',
      EXECUTOR_REMOTE_TOKEN_ENV,
      '-C',
      input.cwd,
    ],
  }
}
