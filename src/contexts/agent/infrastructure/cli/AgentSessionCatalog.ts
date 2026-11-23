import fs from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'
import type {
  AgentSessionSummary,
  ListAgentSessionsInput,
  ListAgentSessionsResult,
} from '@shared/contracts/dto'
import { resolveHomeDirectoryCandidates } from '../../../../platform/os/HomeDirectory'
import { mapWithConcurrency } from '../../../../shared/utils/mapWithConcurrency'
import { normalizeAgentProjectRootPath } from '../AgentProjectRootPath'
import { resolveClaudeProjectDirectoryCandidateGroups } from '../ClaudeProjectPaths'
import { listDirectories, listFiles, parseTimestampMs } from './AgentSessionLocatorProviders.utils'
import { listOpenCodeSessions } from './AgentSessionCatalog.openCode'
import { listCodexSessions } from './AgentSessionCatalog.codex'
import { listPiSessions } from './AgentSessionCatalog.pi'
import { readSessionFileWithCache } from './AgentSessionCatalog.cache'
import { runSingleFlight } from './AgentSessionCatalog.singleFlight'
import type { AgentSessionTitleCacheStore } from './AgentSessionTitleCacheStore'
import {
  normalizeSessionPreview,
  parseGeminiFirstUserPreview,
  readClaudeSessionFilePreview,
} from './AgentSessionCatalog.preview'
import {
  isNonNull,
  normalizeOptionalString,
  sortSessionSummaries,
  toIsoString,
} from './AgentSessionCatalog.shared'

const DEFAULT_AGENT_SESSION_LIMIT = 20
const MAX_AGENT_SESSION_LIMIT = 100

// 只对「已选中的最近 N 个 transcript」做读取,且同时打开的文件数保持很少。
// 扫描 595 个文件返回 20 条时,fds 不再随目录规模增长。
const CLAUDE_FILE_READ_CONCURRENCY = 4
const CLAUDE_FILE_STAT_CONCURRENCY = 16

function normalizeLimit(limit: number | null | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) {
    return DEFAULT_AGENT_SESSION_LIMIT
  }

  return Math.max(1, Math.min(MAX_AGENT_SESSION_LIMIT, Math.floor(limit)))
}

function normalizeSessionIdFromPath(filePath: string): string | null {
  if (extname(filePath) !== '.jsonl') {
    return null
  }

  return normalizeOptionalString(basename(filePath, '.jsonl'))
}

function toClaudeProjectDirs(cwd: string): string[] {
  return resolveClaudeProjectDirectoryCandidateGroups(cwd)[0] ?? []
}

async function listClaudeSessions(
  cwd: string,
  limit: number,
  titleCache?: AgentSessionTitleCacheStore,
): Promise<AgentSessionSummary[]> {
  const resolvedCwd = resolve(cwd)
  const projectDirs = toClaudeProjectDirs(resolvedCwd)
  const indexedSessions = (
    await Promise.all(
      projectDirs.map(async projectDir => {
        const indexPath = join(projectDir, 'sessions-index.json')
        const indexContents = await fs.readFile(indexPath, 'utf8').catch(() => null)
        if (!indexContents) {
          return []
        }

        try {
          const parsed = JSON.parse(indexContents) as {
            entries?: Array<{
              sessionId?: unknown
              projectPath?: unknown
              firstPrompt?: unknown
              created?: unknown
              modified?: unknown
              fileMtime?: unknown
            }>
          }

          return Array.isArray(parsed.entries)
            ? parsed.entries
                .map(entry => {
                  const sessionId = normalizeOptionalString(entry.sessionId)
                  const projectPath =
                    typeof entry.projectPath === 'string' ? resolve(entry.projectPath.trim()) : null

                  if (!sessionId || projectPath !== resolvedCwd) {
                    return null
                  }

                  const startedAtMs = parseTimestampMs(entry.created)
                  const updatedAtMs =
                    parseTimestampMs(entry.modified) ?? parseTimestampMs(entry.fileMtime)

                  const firstPrompt = normalizeSessionPreview(entry.firstPrompt)

                  return {
                    sessionId,
                    provider: 'claude-code' as const,
                    cwd: resolvedCwd,
                    title: firstPrompt,
                    preview: firstPrompt,
                    startedAt: toIsoString(startedAtMs),
                    updatedAt: toIsoString(updatedAtMs ?? startedAtMs),
                    source: 'claude-index' as const,
                  }
                })
                .filter(isNonNull)
            : []
        } catch {
          return []
        }
      }),
    )
  ).flat()

  if (indexedSessions.length > 0) {
    return sortSessionSummaries(indexedSessions, limit)
  }

  const files = (
    await mapWithConcurrency(projectDirs, Math.max(1, projectDirs.length), async projectDir => {
      return (await listFiles(projectDir)).filter(filePath => filePath.endsWith('.jsonl'))
    })
  ).flat()
  if (files.length === 0) {
    return []
  }

  const candidates = (
    await mapWithConcurrency(files, CLAUDE_FILE_STAT_CONCURRENCY, async filePath => {
      const sessionId = normalizeSessionIdFromPath(filePath)
      if (!sessionId) {
        return null
      }

      try {
        const stats = await fs.stat(filePath)
        return { filePath, sessionId, mtimeMs: stats.mtimeMs, size: stats.size }
      } catch {
        return null
      }
    })
  ).filter(isNonNull)

  // 先按 mtime 选出最近 N 个,再打开文件。目录里可能有数百个历史 transcript,
  // 但本次请求只应触碰能进入结果集的那部分。
  const selectedCandidates = candidates
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, limit)

  const sessions = (
    await mapWithConcurrency(selectedCandidates, CLAUDE_FILE_READ_CONCURRENCY, async candidate => {
      try {
        const { title, preview } = await readSessionFileWithCache(
          candidate.filePath,
          { mtimeMs: candidate.mtimeMs, size: candidate.size },
          async () => {
            // 单次打开、单次扫描,同时取首条用户消息(preview)与 ai-title(title)。
            const filePreview = await readClaudeSessionFilePreview(candidate.filePath)
            return {
              title: filePreview.aiTitle ?? filePreview.preview,
              preview: filePreview.preview,
            }
          },
          titleCache ? { store: titleCache, provider: 'claude-code' } : undefined,
        )
        return {
          sessionId: candidate.sessionId,
          provider: 'claude-code' as const,
          cwd: resolvedCwd,
          title,
          preview,
          startedAt: null,
          updatedAt: toIsoString(candidate.mtimeMs),
          source: 'claude-jsonl' as const,
        }
      } catch {
        return null
      }
    })
  ).filter(isNonNull)

  return sortSessionSummaries(sessions, limit)
}

function parseGeminiSessionSummary(rawContents: string, cwd: string): AgentSessionSummary | null {
  try {
    const parsed = JSON.parse(rawContents) as {
      sessionId?: unknown
      startTime?: unknown
      lastUpdated?: unknown
    }

    const sessionId = normalizeOptionalString(parsed.sessionId)
    if (!sessionId) {
      return null
    }

    const preview = parseGeminiFirstUserPreview(parsed)
    const startedAtMs = parseTimestampMs(parsed.startTime)
    const updatedAtMs = parseTimestampMs(parsed.lastUpdated)

    return {
      sessionId,
      provider: 'gemini',
      cwd,
      title: preview,
      preview,
      startedAt: toIsoString(startedAtMs),
      updatedAt: toIsoString(updatedAtMs ?? startedAtMs),
      source: 'gemini-file',
    }
  } catch {
    return null
  }
}

async function listGeminiSessions(
  cwd: string,
  limit: number,
  titleCache?: AgentSessionTitleCacheStore,
): Promise<AgentSessionSummary[]> {
  const resolvedCwd = resolve(cwd)
  const projectDirectories = (
    await Promise.all(
      resolveHomeDirectoryCandidates().map(async homeDirectory => {
        const geminiTmpDir = join(homeDirectory, '.gemini', 'tmp')
        return await listDirectories(geminiTmpDir)
      }),
    )
  ).flat()

  const matchingProjectDirectories = (
    await Promise.all(
      projectDirectories.map(async projectDirectory => {
        const projectRoot = await fs
          .readFile(join(projectDirectory, '.project_root'), 'utf8')
          .then(normalizeAgentProjectRootPath)
          .catch(() => null)

        return projectRoot === resolvedCwd ? projectDirectory : null
      }),
    )
  ).filter((projectDirectory): projectDirectory is string => projectDirectory !== null)

  const sessions = (
    await Promise.all(
      matchingProjectDirectories.map(async projectDirectory => {
        const chatFiles = (await listFiles(join(projectDirectory, 'chats'))).filter(filePath => {
          return filePath.endsWith('.json') && basename(filePath).startsWith('session-')
        })

        return await Promise.all(
          chatFiles.map(async chatFile => {
            const fingerprint = await fs
              .stat(chatFile)
              .then(stats => ({ mtimeMs: stats.mtimeMs, size: stats.size }))
              .catch(() => null)
            return await readSessionFileWithCache(
              chatFile,
              fingerprint,
              async () => {
                const contents = await fs.readFile(chatFile, 'utf8').catch(() => null)
                return contents ? parseGeminiSessionSummary(contents, resolvedCwd) : null
              },
              titleCache ? { store: titleCache, provider: 'gemini' } : undefined,
            )
          }),
        )
      }),
    )
  )
    .flat(2)
    .filter((session): session is AgentSessionSummary => session !== null)

  return sortSessionSummaries(sessions, limit)
}

export async function listAgentSessions(
  input: ListAgentSessionsInput,
  options?: { titleCache?: AgentSessionTitleCacheStore },
): Promise<ListAgentSessionsResult> {
  const resolvedCwd = resolve(input.cwd)
  const limit = normalizeLimit(input.limit)
  const titleCache = options?.titleCache

  if (input.provider === 'claude-code') {
    // key 包含 limit 与缓存模式:不同 limit 需要不同深度的扫描结果,不能复用
    // 被截断的列表。渲染层重复请求使用同一 limit,仍共享同一次扫描。
    const cacheKey = `claude-code\u0000${resolvedCwd}\u0000${limit}\u0000${titleCache ? 'l2' : 'l1'}`
    return {
      provider: input.provider,
      cwd: resolvedCwd,
      sessions: await runSingleFlight(cacheKey, async () => {
        return await listClaudeSessions(resolvedCwd, limit, titleCache)
      }),
    }
  }

  const sessions =
    input.provider === 'codex'
      ? await listCodexSessions(resolvedCwd, limit, titleCache)
      : input.provider === 'gemini'
        ? await listGeminiSessions(resolvedCwd, limit, titleCache)
        : input.provider === 'opencode'
          ? await listOpenCodeSessions(resolvedCwd, limit)
          : input.provider === 'pi'
            ? await listPiSessions(resolvedCwd, limit, titleCache)
            : []

  return {
    provider: input.provider,
    cwd: resolvedCwd,
    sessions,
  }
}
