import fs from 'node:fs/promises'
import { join } from 'node:path'
import { resolveClaudeProjectDirectoryCandidateGroups } from './ClaudeProjectPaths'

export type ClaudeTranscriptStatus = 'present' | 'missing' | 'unknown'

function isMissingFileError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/**
 * Resolves whether Claude can resume the given session transcript. Only ENOENT means
 * the transcript is absent; any other filesystem error is reported as unknown so the
 * caller keeps the existing resume binding instead of replacing a valid session.
 */
export async function resolveClaudeTranscriptStatus(options: {
  cwd: string
  sessionId: string
  homeDirectories?: string[]
  configDirectory?: string | null
}): Promise<ClaudeTranscriptStatus> {
  const sessionId = options.sessionId.trim()
  if (sessionId.length === 0) {
    return 'missing'
  }

  const candidateGroups = resolveClaudeProjectDirectoryCandidateGroups(
    options.cwd,
    options.homeDirectories,
    options.configDirectory ?? undefined,
  )
  let sawUnknown = false

  for (const candidateGroup of candidateGroups) {
    for (const projectDirectory of candidateGroup) {
      try {
        // eslint-disable-next-line no-await-in-loop -- short-circuit on the first hit
        const stats = await fs.stat(join(projectDirectory, `${sessionId}.jsonl`))
        if (stats.isFile()) {
          return 'present'
        }

        sawUnknown = true
      } catch (error) {
        if (!isMissingFileError(error)) {
          sawUnknown = true
        }
      }
    }
  }

  return sawUnknown ? 'unknown' : 'missing'
}
