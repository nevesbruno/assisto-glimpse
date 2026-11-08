// Frozen wire-format values written by shipped OpenCove builds.
export const LEGACY_MANAGED_CLAUDE_HOOK_STATUS_MESSAGE = 'OpenCove agent status'
export const LEGACY_MANAGED_CODEX_HOOK_DESCRIPTION = 'OpenCove managed agent status hooks'

export interface LegacyHookCleanupResult<T> {
  readonly content: T
  readonly removedCount: number
}

// Codex trust keys are `<hooks.json path>:<snake_case event>:<group index>:<hook index>`.
// Value: first group index (inclusive) whose trust entry no longer matches its group.
export type StaleCodexTrust = ReadonlyMap<string, number>

export interface LegacyCodexHooksCleanupResult extends LegacyHookCleanupResult<unknown> {
  readonly staleTrust: StaleCodexTrust
}

type JsonRecord = Record<string, unknown>
type ManagedGroupPredicate = (value: unknown) => boolean

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

interface HookGroupsCleanup extends LegacyHookCleanupResult<unknown> {
  readonly firstRemovedIndexByEvent: ReadonlyMap<string, number>
}

function cleanHookGroups(
  config: unknown,
  isManagedGroup: ManagedGroupPredicate,
): HookGroupsCleanup {
  const firstRemovedIndexByEvent = new Map<string, number>()
  if (!isRecord(config) || !isRecord(config.hooks)) {
    return { content: config, removedCount: 0, firstRemovedIndexByEvent }
  }

  let removedCount = 0
  const hooks: JsonRecord = {}
  for (const [eventName, groups] of Object.entries(config.hooks)) {
    if (!Array.isArray(groups)) {
      hooks[eventName] = groups
      continue
    }

    const retained = groups.filter((group, index) => {
      if (!isManagedGroup(group)) {
        return true
      }
      removedCount += 1
      if (!firstRemovedIndexByEvent.has(eventName)) {
        firstRemovedIndexByEvent.set(eventName, index)
      }
      return false
    })
    if (retained.length > 0) {
      hooks[eventName] = retained
    }
  }

  if (removedCount === 0) {
    return { content: config, removedCount: 0, firstRemovedIndexByEvent }
  }

  const content: JsonRecord = { ...config }
  if (Object.keys(hooks).length > 0) {
    content.hooks = hooks
  } else {
    delete content.hooks
  }
  return { content, removedCount, firstRemovedIndexByEvent }
}

function isLegacyClaudeHookGroup(value: unknown): boolean {
  return (
    isRecord(value) &&
    Array.isArray(value.hooks) &&
    value.hooks.some(
      hook => isRecord(hook) && hook.statusMessage === LEGACY_MANAGED_CLAUDE_HOOK_STATUS_MESSAGE,
    )
  )
}

export function cleanLegacyClaudeSettings(settings: unknown): LegacyHookCleanupResult<unknown> {
  const { content, removedCount } = cleanHookGroups(settings, isLegacyClaudeHookGroup)
  return { content, removedCount }
}

export function isLegacyOpenCoveCodexHooksFile(parsed: unknown): boolean {
  return isRecord(parsed) && parsed.description === LEGACY_MANAGED_CODEX_HOOK_DESCRIPTION
}

function isLegacyCodexHookGroup(value: unknown): boolean {
  if (!isRecord(value)) {
    return false
  }
  if (value.description === LEGACY_MANAGED_CODEX_HOOK_DESCRIPTION) {
    return true
  }
  return (
    Array.isArray(value.hooks) &&
    value.hooks.some(
      hook => isRecord(hook) && hook.description === LEGACY_MANAGED_CODEX_HOOK_DESCRIPTION,
    )
  )
}

function toCodexTrustEventName(eventName: string): string {
  return eventName.replace(/([a-z0-9])([A-Z])/gu, '$1_$2').toLowerCase()
}

function toStaleTrust(firstRemovedIndexByEvent: ReadonlyMap<string, number>): StaleCodexTrust {
  return new Map(
    [...firstRemovedIndexByEvent].map(([eventName, index]) => [
      toCodexTrustEventName(eventName),
      index,
    ]),
  )
}

export function cleanLegacyCodexHooksFile(parsed: unknown): LegacyCodexHooksCleanupResult {
  const { content, removedCount, firstRemovedIndexByEvent } = cleanHookGroups(
    parsed,
    isLegacyCodexHookGroup,
  )
  return { content, removedCount, staleTrust: toStaleTrust(firstRemovedIndexByEvent) }
}

// Trust of a hooks.json that is deleted whole: every group of every event goes stale.
export function collectWholeFileStaleTrust(parsed: unknown): StaleCodexTrust {
  const events = isRecord(parsed) && isRecord(parsed.hooks) ? Object.keys(parsed.hooks) : []
  return toStaleTrust(new Map(events.map(eventName => [eventName, 0])))
}

const CODEX_STATE_HEADER_PATTERN = /^\s*\[hooks\.state\."((?:[^"\\]|\\.)*)"\]\s*(?:#.*)?$/u
const LEGACY_CODEX_HOOK_REFERENCE_PATTERN =
  /(?:^|\/)\.codex\/hooks\.json:([A-Za-z0-9_-]+):(\d+):\d+$/u
const TOML_TABLE_HEADER_PATTERN = /^\s*(?:\[\[[^\]\r\n]+\]\]|\[[^\]\r\n]+\])\s*(?:#.*)?$/u
const TOML_TABLE_LIKE_PATTERN = /^\s*\[/u

// Trust is positional: removing group N shifts later groups, so entries from N onward are dropped.
// Entries of hooks the cleanup did not remove or shift (other events, earlier groups) stay.
function isStaleCodexTrustTable(line: string, staleTrust: StaleCodexTrust): boolean {
  const match = CODEX_STATE_HEADER_PATTERN.exec(line)
  if (!match?.[1]) {
    return false
  }

  let key = match[1]
  try {
    key = JSON.parse(`"${key}"`) as string
  } catch {
    return false
  }
  const reference = LEGACY_CODEX_HOOK_REFERENCE_PATTERN.exec(key.replaceAll('\\', '/'))
  const firstStaleGroup = reference?.[1] ? staleTrust.get(reference[1]) : undefined
  return firstStaleGroup !== undefined && Number(reference?.[2]) >= firstStaleGroup
}

function linesWithEndings(content: string): string[] {
  return content.match(/[^\r\n]*(?:\r\n|\n|\r|$)/gu)?.filter(Boolean) ?? []
}

function withoutLineEnding(line: string): string {
  return line.replace(/[\r\n]+$/u, '')
}

export function cleanLegacyCodexConfigToml(
  toml: string,
  staleTrust: StaleCodexTrust,
): LegacyHookCleanupResult<string> {
  if (staleTrust.size === 0) {
    return { content: toml, removedCount: 0 }
  }
  const lines = linesWithEndings(toml)
  const output: string[] = []
  let removedCount = 0
  let removingLegacyTable = false

  for (const line of lines) {
    const normalized = withoutLineEnding(line)
    const isTableHeader = TOML_TABLE_HEADER_PATTERN.test(normalized)
    if (!isTableHeader && removingLegacyTable && TOML_TABLE_LIKE_PATTERN.test(normalized)) {
      return { content: toml, removedCount: 0 }
    }

    if (isTableHeader) {
      removingLegacyTable = isStaleCodexTrustTable(normalized, staleTrust)
      if (removingLegacyTable) {
        removedCount += 1
      } else {
        output.push(line)
      }
      continue
    }

    if (!removingLegacyTable) {
      output.push(line)
    }
  }

  return removedCount === 0
    ? { content: toml, removedCount: 0 }
    : { content: output.join(''), removedCount }
}
