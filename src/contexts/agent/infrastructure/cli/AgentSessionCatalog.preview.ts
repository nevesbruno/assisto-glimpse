import fs from 'node:fs/promises'
import { StringDecoder } from 'node:string_decoder'

const JSONL_SCAN_CHUNK_BYTES = 4096
const JSONL_SCAN_MAX_BYTES = 64 * 1024
const SESSION_PREVIEW_MAX_CHARS = 160

// ai-title 这类语义标题行可能写在长会话很靠后的位置(实测可达数 MB),
// 64KB 的默认上限会扫不到而漏读。深度扫描放宽到该上限;因为按 chunk 流式
// 读取、命中即返回,内存始终受控,该上限只作为防御极端大文件的安全阀。
export const JSONL_DEEP_SCAN_MAX_BYTES = 32 * 1024 * 1024

function truncatePreview(value: string): string {
  if (value.length <= SESSION_PREVIEW_MAX_CHARS) {
    return value
  }

  return `${value.slice(0, SESSION_PREVIEW_MAX_CHARS - 3).trimEnd()}...`
}

export function normalizeSessionPreview(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }

  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length === 0) {
    return null
  }

  return truncatePreview(normalized)
}

function extractTextFromContentArray(content: unknown): string | null {
  if (!Array.isArray(content)) {
    return null
  }

  const parts: string[] = []

  for (const item of content) {
    if (!item || typeof item !== 'object') {
      continue
    }

    const record = item as { type?: unknown; text?: unknown }
    if (
      (record.type === 'input_text' || record.type === 'text') &&
      typeof record.text === 'string'
    ) {
      parts.push(record.text)
    }
  }

  return normalizeSessionPreview(parts.join(' '))
}

export function extractTextFromMessageContent(content: unknown): string | null {
  if (typeof content === 'string') {
    return normalizeSessionPreview(content)
  }

  return extractTextFromContentArray(content)
}

function looksLikeCodexBootstrapPrompt(preview: string): boolean {
  return (
    preview.startsWith('# AGENTS.md instructions for ') ||
    preview.startsWith('<environment_context>') ||
    (preview.includes('AGENTS.md instructions') && preview.includes('<environment_context>'))
  )
}

export function parseCodexFirstUserPreview(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== 'object') {
    return null
  }

  const record = parsed as {
    type?: unknown
    role?: unknown
    content?: unknown
    payload?: {
      type?: unknown
      role?: unknown
      content?: unknown
    }
  }

  let content: unknown = null

  if (record.type === 'message' && record.role === 'user') {
    content = record.content
  } else if (record.type === 'response_item') {
    const payload = record.payload
    if (payload?.type === 'message' && payload.role === 'user') {
      content = payload.content
    }
  }

  if (content === null) {
    return null
  }

  const preview = extractTextFromMessageContent(content)
  if (!preview || looksLikeCodexBootstrapPrompt(preview)) {
    return null
  }

  return preview
}

export function parseClaudeAiTitle(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== 'object') {
    return null
  }

  const record = parsed as {
    type?: unknown
    aiTitle?: unknown
  }

  if (record.type !== 'ai-title') {
    return null
  }

  return normalizeSessionPreview(record.aiTitle)
}

export function parseClaudeFirstUserPreview(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== 'object') {
    return null
  }

  const record = parsed as {
    type?: unknown
    content?: unknown
    message?: {
      role?: unknown
      content?: unknown
    }
  }

  if (record.type !== 'user') {
    return null
  }

  return (
    extractTextFromMessageContent(record.content) ??
    extractTextFromMessageContent(record.message?.content)
  )
}

export function parseGeminiFirstUserPreview(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== 'object') {
    return null
  }

  const record = parsed as {
    messages?: Array<{
      type?: unknown
      role?: unknown
      content?: unknown
      parts?: unknown
    }>
  }

  if (!Array.isArray(record.messages)) {
    return null
  }

  for (const message of record.messages) {
    if (!message || typeof message !== 'object') {
      continue
    }

    const raw =
      typeof message.type === 'string'
        ? message.type
        : typeof message.role === 'string'
          ? message.role
          : null
    const role = raw ? raw.trim().toLowerCase() : ''

    if (role !== 'user' && role !== 'human') {
      continue
    }

    return (
      extractTextFromMessageContent(message.content) ?? extractTextFromMessageContent(message.parts)
    )
  }

  return null
}

async function scanJsonlFile(
  filePath: string,
  maxBytes: number,
  onValue: (parsed: unknown) => boolean,
): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null

  try {
    handle = await fs.open(filePath, 'r')
    const decoder = new StringDecoder('utf8')
    const buffer = Buffer.allocUnsafe(JSONL_SCAN_CHUNK_BYTES)
    let bytesReadTotal = 0
    let remainder = ''

    while (bytesReadTotal < maxBytes) {
      const bytesToRead = Math.min(buffer.length, maxBytes - bytesReadTotal)
      // eslint-disable-next-line no-await-in-loop
      const { bytesRead } = await handle.read(buffer, 0, bytesToRead, null)
      if (bytesRead <= 0) {
        break
      }

      bytesReadTotal += bytesRead
      const merged = `${remainder}${decoder.write(buffer.subarray(0, bytesRead))}`
      const lines = merged.split('\n')
      remainder = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed.length === 0) {
          continue
        }

        try {
          if (onValue(JSON.parse(trimmed))) {
            return
          }
        } catch {
          // Ignore malformed or irrelevant lines and continue scanning.
        }
      }
    }

    if (bytesReadTotal >= maxBytes) {
      return
    }

    const finalLine = `${remainder}${decoder.end()}`.trim()
    if (finalLine.length === 0) {
      return
    }

    try {
      onValue(JSON.parse(finalLine))
    } catch {
      // Ignore a malformed trailing line.
    }
  } catch {
    // Missing/unreadable files are treated as no match.
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

export async function readFirstMatchingJsonlValue<T>(
  filePath: string,
  match: (parsed: unknown) => T | null,
  maxBytes: number = JSONL_SCAN_MAX_BYTES,
): Promise<T | null> {
  const state: { value: T | null } = { value: null }

  await scanJsonlFile(filePath, maxBytes, parsed => {
    const matched = match(parsed)
    if (matched === null) {
      return false
    }

    state.value = matched
    return true
  })

  return state.value
}

export interface ClaudeSessionFilePreview {
  preview: string | null
  aiTitle: string | null
}

/**
 * 单次打开、单次顺序扫描,同时取出 Claude 会话的首条用户消息与 ai-title。
 *
 * 两者位置不同(预览在文件开头,标题可能埋在深处),合并扫描避免对同一文件
 * 打开两次、重复读取。找到两者后立即停止;没有 ai-title 时最多扫到深度上限。
 */
export async function readClaudeSessionFilePreview(
  filePath: string,
): Promise<ClaudeSessionFilePreview> {
  const state: ClaudeSessionFilePreview = { preview: null, aiTitle: null }

  await scanJsonlFile(filePath, JSONL_DEEP_SCAN_MAX_BYTES, parsed => {
    if (state.preview === null) {
      state.preview = parseClaudeFirstUserPreview(parsed)
    }

    if (state.aiTitle === null) {
      state.aiTitle = parseClaudeAiTitle(parsed)
    }

    return state.preview !== null && state.aiTitle !== null
  })

  return state
}
