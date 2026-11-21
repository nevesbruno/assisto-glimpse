export const OPEN_CODE_SERVER_PASSWORD_ENV = 'OPENCODE_SERVER_PASSWORD'

export interface OpenCodeServeArgsInput {
  readonly port: number
}

/** The serve line carries no secret: the password goes in the child environment only. */
export function openCodeServeArgs(input: OpenCodeServeArgsInput): string[] {
  return ['serve', '--hostname', '127.0.0.1', '--port', String(input.port)]
}

/** Worker environment without `OPENCOVE_*`, plus the provider variables from the settings. */
export function buildOpenCodeProcessEnv(
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

/** The password exists only here and in the child: never in argv, never in the persisted link. */
export function openCodeServeEnv(
  env: Readonly<Record<string, string>>,
  password: string,
): Record<string, string> {
  return { ...env, [OPEN_CODE_SERVER_PASSWORD_ENV]: password }
}
