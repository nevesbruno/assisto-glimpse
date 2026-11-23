export interface CodexHookTrust {
  readonly key: string
  readonly trustedHash: string
}

export interface CodexAppServerArgsInput {
  readonly port: number
  readonly tokenSha256: string
  readonly cwd: string
  readonly hookTrust: readonly CodexHookTrust[]
}

/** TOML basic string. JSON escapes cover quote, backslash and C0; DEL is the only extra TOML rejects. */
function tomlString(value: string): string {
  return JSON.stringify(value).replaceAll('\u007f', '\\u007f')
}

/** Inline table form only: the dotted form is ignored by the server (V2 and V3). */
export function buildCodexAppServerArgs(input: CodexAppServerArgsInput): string[] {
  const args = [
    'app-server',
    '--listen',
    `ws://127.0.0.1:${input.port}`,
    '--ws-auth',
    'capability-token',
    '--ws-token-sha256',
    input.tokenSha256,
    '-c',
    `projects={${tomlString(input.cwd)}={trust_level="trusted"}}`,
  ]
  if (input.hookTrust.length > 0) {
    const entries = input.hookTrust
      .map(hook => `${tomlString(hook.key)}={trusted_hash=${tomlString(hook.trustedHash)}}`)
      .join(',')
    args.push('-c', `hooks.state={${entries}}`)
  }
  return args
}

/** Worker environment without `OPENCOVE_*`, plus the provider variables from the settings. */
export function buildCodexProcessEnv(
  base: Readonly<Record<string, string | undefined>>,
  providerEnv: Readonly<Record<string, string>>,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(base)) {
    if (value !== undefined && !name.startsWith('OPENCOVE_')) {
      env[name] = value
    }
  }
  return { ...env, ...providerEnv }
}
