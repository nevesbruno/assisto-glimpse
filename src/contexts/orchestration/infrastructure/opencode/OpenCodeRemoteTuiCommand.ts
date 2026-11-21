export const OPEN_CODE_REMOTE_PASSWORD_ENV = 'OPENCODE_SERVER_PASSWORD'

const LOOPBACK_HTTP_URL = /^http:\/\/127\.0\.0\.1:\d+$/

export interface OpenCodeRemoteTuiInput {
  readonly executablePath: string
  readonly sessionId: string
  readonly url: string
  readonly cwd: string
}

/**
 * The TUI follows the service the Worker started; the password travels by variable name, never as
 * text. The TUI is also the way the user answers approvals that the Glimpse window does not show.
 */
export function buildOpenCodeRemoteTuiCommand(input: OpenCodeRemoteTuiInput): {
  command: string
  args: string[]
} {
  if (!LOOPBACK_HTTP_URL.test(input.url)) {
    throw new Error('Executor TUI endpoint must be a loopback http URL.')
  }
  return {
    command: input.executablePath,
    args: ['--server', input.url, '--session', input.sessionId, input.cwd],
  }
}
