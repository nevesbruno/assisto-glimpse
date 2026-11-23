#!/usr/bin/env node
/**
 * Spike da Mesa de coordenação: probe da interface de controle do Glimpse.
 *
 * Uso:
 *   node probe.mjs [profileDir]
 *
 * Sem dependências. Lê o worker-control-surface.json do perfil, chama /invoke,
 * assina /events por 5 s, mede latência e grava saida.json ao lado do script.
 * Nunca imprime o token: toda saída passa pelo redator.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROFILE = path.resolve(
  process.argv[2] ?? path.join(os.homedir(), '.config/opencove-dev'),
)
const CONNECTION_FILE = path.join(PROFILE, 'worker-control-surface.json')
const PROTOCOL = '2'
const EVENT_WINDOW_MS = 5000

const home = os.homedir()
let secrets = []

function redact(value) {
  if (typeof value === 'string') {
    let out = value.split(home).join('~')
    for (const secret of secrets) out = out.split(secret).join('<redacted-token>')
    return out.replace(/\/worker-control-surface\.json/g, '/<redacted-file>')
  }
  if (Array.isArray(value)) return value.map(redact)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v)]))
  }
  return value
}

function percentile(values, p) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return Math.round(sorted[index])
}

const calls = []
let baseUrl
let token

async function invoke(id, kind, payload) {
  const started = performance.now()
  const entry = { id, kind, payload: redact(payload ?? {}), ok: false, ms: null }
  try {
    const response = await fetch(`${baseUrl}/invoke`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-opencove-protocol': PROTOCOL,
      },
      body: JSON.stringify({ kind, id, payload: payload ?? {} }),
      signal: AbortSignal.timeout(15000),
    })
    const body = await response.json()
    entry.status = response.status
    entry.ms = Math.round(performance.now() - started)
    if (body?.ok === true) {
      entry.ok = true
      entry.value = redact(body.value)
    } else {
      entry.error = redact(body?.error ?? body)
    }
  } catch (error) {
    entry.ms = Math.round(performance.now() - started)
    entry.error = { code: 'probe.transport', message: String(error?.message ?? error) }
  }
  calls.push(entry)
  return entry
}

async function readEvents() {
  const started = performance.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), EVENT_WINDOW_MS)
  const result = {
    connected: false,
    status: null,
    windowMs: EVENT_WINDOW_MS,
    connectMs: null,
    bytes: 0,
    frames: 0,
    eventNames: {},
    dataTypes: {},
    samples: [],
  }
  try {
    const response = await fetch(`${baseUrl}/events`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'text/event-stream',
        'x-opencove-protocol': PROTOCOL,
      },
      signal: controller.signal,
    })
    result.connected = response.ok
    result.status = response.status
    result.connectMs = Math.round(performance.now() - started)
    if (!response.ok || !response.body) return result
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
      }
    } catch (error) {
      if (error?.name !== 'AbortError') throw error
    }
    result.bytes = Buffer.byteLength(buffer)
    for (const frame of buffer.split(/\r?\n\r?\n/)) {
      if (!frame.trim() || frame.trim() === ':') continue
      result.frames += 1
      const eventName = frame.match(/^event:\s*(.+)$/m)?.[1]?.trim()
      const dataRaw = frame.match(/^data:\s*([\s\S]*)$/m)?.[1]
      if (eventName) result.eventNames[eventName] = (result.eventNames[eventName] ?? 0) + 1
      if (dataRaw) {
        try {
          const parsed = JSON.parse(dataRaw)
          if (parsed?.type) result.dataTypes[parsed.type] = (result.dataTypes[parsed.type] ?? 0) + 1
          if (result.samples.length < 5) result.samples.push(redact(parsed))
        } catch {
          // frame não-JSON: mantém só a contagem
        }
      }
    }
  } catch (error) {
    if (error?.name !== 'AbortError') {
      result.error = { code: 'probe.events', message: String(error?.message ?? error) }
    }
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
  return result
}

async function main() {
  const surface = JSON.parse(await fs.readFile(CONNECTION_FILE, 'utf8'))
  token = surface.token
  if (token) secrets.push(token)
  baseUrl = `http://${surface.hostname}:${surface.port}`

  const connection = {
    version: surface.version,
    hostname: surface.hostname,
    port: surface.port,
    pid: surface.pid,
    appVersion: surface.appVersion,
    startedBy: surface.startedBy,
    createdAt: surface.createdAt,
  }

  console.log(`conexão: ${baseUrl} pid=${surface.pid} app=${surface.appVersion}`)

  await invoke('system.whoami', 'query', {})
  await invoke('system.ping', 'query', {})
  await invoke('system.capabilities', 'query', {})
  const ops = await invoke('system.operations', 'query', {})
  const projects = await invoke('project.list', 'query', {})

  const projectList = projects.value?.projects ?? []
  for (const project of projectList) {
    await invoke('space.list', 'query', { projectId: project.id })
    await invoke('node.list', 'query', { projectId: project.id })
    await invoke('agent.list', 'query', { projectId: project.id })
  }
  const agents = await invoke('agent.list', 'query', {})
  const links = await invoke('orch.link.list', 'query', {})
  const status = await invoke('orch.status', 'query', {})

  const linkItems = links.value?.links ?? []
  for (const link of linkItems) {
    await invoke('node.get', 'query', { nodeId: link.executorNodeId })
    if (link.spaceId) await invoke('space.get', 'query', { spaceId: link.spaceId })
  }
  for (const link of status.value?.links ?? []) {
    await invoke('orch.status', 'query', { to: link.executorNodeId })
  }
  const liveAgent = agents.value?.agents?.[0]
  if (liveAgent?.nodeId) await invoke('agent.get', 'query', { nodeId: liveAgent.nodeId })

  const events = await readEvents()

  const timings = calls.map(call => call.ms).filter(ms => typeof ms === 'number')
  const operationIds = (ops.value?.operations ?? []).map(op => op.id)
  const orchOps = (ops.value?.operations ?? []).filter(op => op.id.startsWith('orch.'))

  const linksWithProject = linkItems.filter(link => typeof link.projectId === 'string')
  const statusLinks = status.value?.links ?? []
  const statusHasProject = statusLinks.some(link => 'projectId' in link)
  const attentionFields = statusLinks.some(
    link =>
      Array.isArray(link.pendingApprovals) ||
      Array.isArray(link.pendingHooks) ||
      Array.isArray(link.notices?.items),
  )
  const agentFields = Object.keys(liveAgent ?? {})
  const hasUsage =
    liveAgent !== undefined &&
    calls.some(
      call =>
        call.ok &&
        ['agent.get', 'agent.list'].includes(call.id) &&
        /(token|cost|usage)/i.test(JSON.stringify(call.value ?? {})),
    )

  const out = {
    generatedAt: new Date().toISOString(),
    profile: redact(PROFILE),
    connection,
    protocolHeader: PROTOCOL,
    summary: {
      calls: calls.length,
      ok: calls.filter(call => call.ok).length,
      failed: calls.filter(call => !call.ok).length,
      avgMs: timings.length
        ? Math.round(timings.reduce((sum, ms) => sum + ms, 0) / timings.length)
        : null,
      p50Ms: percentile(timings, 50),
      maxMs: timings.length ? Math.max(...timings) : null,
    },
    facts: {
      projectCount: projectList.length,
      linkCount: linkItems.length,
      linkStates: linkItems.reduce((acc, link) => {
        acc[link.state] = (acc[link.state] ?? 0) + 1
        return acc
      }, {}),
      linksWithProjectId: linksWithProject.length,
      activeStatusLinks: statusLinks.length,
      statusLinkHasProjectId: statusLinks.length ? statusHasProject : null,
      statusAttentionIsItemized: statusLinks.length ? attentionFields : null,
      liveAgents: agents.value?.agents?.length ?? null,
      agentFieldsExposed: agentFields,
      agentExposesTokensCostOrUsage: liveAgent === undefined ? null : hasUsage,
      operationCount: operationIds.length,
      orchOperationIds: orchOps.map(op => op.id),
      queueOperationIds: operationIds.filter(
        id =>
          /(^|\.)(queue|portfolio|attention)(\.|$)/i.test(id) || /^orch\.run\./i.test(id),
      ),
      costOperationIds: operationIds.filter(id => /cost|token|usage|billing/i.test(id)),
    },
    calls,
    projects: projects.value ?? null,
    links: links.value ?? null,
    status: status.value ?? null,
    events,
  }

  const outPath = path.join(HERE, 'saida.json')
  await fs.writeFile(outPath, `${JSON.stringify(out, null, 2)}\n`, 'utf8')

  const fmt = value => (value === null ? 'não provado' : value)
  console.log('')
  console.log(`chamadas: ${out.summary.calls} (${out.summary.ok} ok, ${out.summary.failed} falhas)`)
  console.log(
    `latência: média ${out.summary.avgMs} ms · p50 ${out.summary.p50Ms} ms · máx ${out.summary.maxMs} ms`,
  )
  console.log(`projetos: ${out.facts.projectCount} · links: ${out.facts.linkCount} ${JSON.stringify(out.facts.linkStates)}`)
  console.log(`links com projectId: ${out.facts.linksWithProjectId}/${out.facts.linkCount}`)
  console.log(
    `atenção: statusLinks=${out.facts.activeStatusLinks} itemizado=${fmt(out.facts.statusAttentionIsItemized)}`,
  )
  console.log(
    `agentes vivos: ${out.facts.liveAgents} · tokens/custo expostos: ${fmt(out.facts.agentExposesTokensCostOrUsage)}`,
  )
  console.log(`catálogo: ${out.facts.operationCount} ops · fila=${out.facts.queueOperationIds.length} · custo=${out.facts.costOperationIds.length}`)
  console.log(
    `eventos: conectado=${events.connected} frames=${events.frames} nomes=${JSON.stringify(events.eventNames)} tipos=${JSON.stringify(events.dataTypes)}`,
  )
  console.log(`saída: ${redact(outPath)}`)

  const failed = calls.filter(call => !call.ok)
  if (failed.length > 0) {
    console.log('falhas:')
    for (const call of failed) {
      console.log(`  ${call.id} → ${call.error?.code ?? 'erro'} (${call.ms} ms)`)
    }
  }
}

main().catch(error => {
  console.error(`probe falhou: ${redact(String(error?.stack ?? error))}`)
  process.exitCode = 1
})
