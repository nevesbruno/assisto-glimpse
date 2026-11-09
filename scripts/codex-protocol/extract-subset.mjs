#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const MIN_CODEX_VERSION = '0.167.0'
export const SUBSET_SIZE_LIMIT_BYTES = 300 * 1024

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PROTOCOL_DIR = join(REPO_ROOT, 'src/contexts/orchestration/infrastructure/codex/protocol')
export const SUBSET_PATH = join(PROTOCOL_DIR, 'codex-protocol.subset.json')
export const MANIFEST_PATH = join(PROTOCOL_DIR, 'manifest.json')

export const USED_METHODS = {
  clientRequests: [
    'initialize',
    'thread/start',
    'thread/resume',
    'thread/name/set',
    'thread/unsubscribe',
    'thread/archive',
    'thread/turns/list',
    'turn/start',
    'turn/interrupt',
    'hooks/list',
  ],
  clientNotifications: ['initialized'],
  serverNotifications: [
    'thread/started',
    'thread/status/changed',
    'turn/started',
    'turn/completed',
    'item/started',
    'item/completed',
    'hook/completed',
    'serverRequest/resolved',
    'error',
  ],
  serverRequests: [
    'item/commandExecution/requestApproval',
    'item/fileChange/requestApproval',
    'item/permissions/requestApproval',
    'mcpServer/elicitation/request',
    'item/tool/requestUserInput',
  ],
}

const SCHEMA_DIRS = ['v2', '', 'v1']

export function readInstalledVersion(codexBin = 'codex') {
  const result = spawnSync(codexBin, ['--version'], { encoding: 'utf8' })
  const match = /(\d+\.\d+\.\d+)/.exec(result.stdout ?? '')
  if (result.status !== 0 || !match) {
    throw new Error(`codex --version falhou: ${result.stderr || result.error?.message}`)
  }
  return match[1]
}

export function compareVersions(left, right) {
  const a = left.split('.').map(Number)
  const b = right.split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) {
      return a[index] - b[index]
    }
  }
  return 0
}

export function assertMinimumVersion(version) {
  if (compareVersions(version, MIN_CODEX_VERSION) < 0) {
    throw new Error(
      `Codex ${version} abaixo da versão mínima ${MIN_CODEX_VERSION}: o adaptador do executor não suporta.`,
    )
  }
}

export function withGeneratedSchema(callback, codexBin = 'codex') {
  const root = mkdtempSync(join(tmpdir(), 'glimpse-codex-schema-'))
  try {
    const codexHome = join(root, 'home')
    const schemaDir = join(root, 'schema')
    mkdirSync(codexHome)
    mkdirSync(schemaDir)
    const result = spawnSync(codexBin, ['app-server', 'generate-json-schema', '--out', schemaDir], {
      encoding: 'utf8',
      env: { ...process.env, CODEX_HOME: codexHome },
    })
    if (result.status !== 0) {
      throw new Error(`generate-json-schema falhou: ${result.stderr || result.error?.message}`)
    }
    return callback(schemaDir)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function readSchemaFile(schemaDir, name) {
  for (const sub of SCHEMA_DIRS) {
    const file = join(schemaDir, sub, `${name}.json`)
    if (existsSync(file)) {
      return JSON.parse(readFileSync(file, 'utf8'))
    }
  }
  throw new Error(`Esquema ${name}.json ausente na saída do Codex`)
}

function normalizeRefs(node) {
  if (Array.isArray(node)) {
    return node.map(normalizeRefs)
  }
  if (node && typeof node === 'object') {
    return Object.fromEntries(
      Object.entries(node).map(([key, value]) => [
        key,
        key === '$ref' && typeof value === 'string'
          ? value.replace('#/definitions/v2/', '#/definitions/')
          : normalizeRefs(value),
      ]),
    )
  }
  return node
}

function sortKeys(node) {
  if (Array.isArray(node)) {
    return node.map(sortKeys)
  }
  if (node && typeof node === 'object') {
    return Object.fromEntries(
      Object.keys(node)
        .sort()
        .map(key => [key, sortKeys(node[key])]),
    )
  }
  return node
}

function refName(ref) {
  return ref.slice(ref.lastIndexOf('/') + 1)
}

function methodTable(schemaDir, fileName) {
  const table = new Map()
  for (const variant of readSchemaFile(schemaDir, fileName).oneOf) {
    const method = variant.properties.method.enum[0]
    const params = variant.properties.params?.$ref
    table.set(method, params ? refName(params) : null)
  }
  return table
}

function addDefinitions(target, schemaName, schema) {
  const { definitions = {}, $schema: _ignored, ...root } = normalizeRefs(schema)
  const incoming = { ...normalizeRefs(definitions), [schemaName]: root }
  for (const [name, definition] of Object.entries(incoming)) {
    const serialized = JSON.stringify(sortKeys(definition))
    if (target[name] !== undefined && JSON.stringify(target[name]) !== serialized) {
      throw new Error(`Definição ${name} difere entre esquemas do Codex`)
    }
    target[name] = sortKeys(definition)
  }
}

export function buildSubset(schemaDir) {
  const definitions = {}
  const methods = {}
  const groups = [
    ['clientRequests', 'ClientRequest', true],
    ['clientNotifications', 'ClientNotification', false],
    ['serverNotifications', 'ServerNotification', false],
    ['serverRequests', 'ServerRequest', true],
  ]
  for (const [group, tableFile, hasResponse] of groups) {
    const table = methodTable(schemaDir, tableFile)
    for (const method of USED_METHODS[group]) {
      if (!table.has(method)) {
        throw new Error(`Método ${method} ausente em ${tableFile}`)
      }
      const params = table.get(method)
      const entry = { kind: group }
      if (params) {
        entry.params = params
        addDefinitions(definitions, params, readSchemaFile(schemaDir, params))
      }
      if (hasResponse) {
        entry.response = params.replace(/Params$/, 'Response')
        addDefinitions(definitions, entry.response, readSchemaFile(schemaDir, entry.response))
      }
      methods[method] = entry
    }
  }
  return sortKeys({ methods, definitions })
}

export function serializeSubset(subset) {
  const methods = Object.entries(subset.methods)
    .map(([name, entry]) => `${JSON.stringify(name)}:${JSON.stringify(entry)}`)
    .join(',\n')
  const definitions = Object.entries(subset.definitions)
    .map(([name, definition]) => `${JSON.stringify(name)}:${JSON.stringify(definition)}`)
    .join(',\n')
  return `{"methods":{\n${methods}\n},"definitions":{\n${definitions}\n}}\n`
}

const sha256 = text => createHash('sha256').update(text).digest('hex')

export function buildManifest(subset, codexVersion) {
  const text = serializeSubset(subset)
  return {
    codexVersion,
    minCodexVersion: MIN_CODEX_VERSION,
    methods: Object.keys(subset.methods),
    subsetBytes: Buffer.byteLength(text),
    subsetSha256: sha256(text),
    definitionHashes: Object.fromEntries(
      Object.entries(subset.definitions).map(([name, definition]) => [
        name,
        sha256(JSON.stringify(definition)),
      ]),
    ),
  }
}

function flatten(node, path, out) {
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      flatten(value, path ? `${path}.${key}` : key, out)
    }
    if (Object.keys(node).length === 0) {
      out.set(path, Array.isArray(node) ? '[]' : '{}')
    }
  } else {
    out.set(path, JSON.stringify(node))
  }
  return out
}

export function diffSubsets(committed, installed) {
  const lines = []
  for (const section of ['methods', 'definitions']) {
    const names = new Set([...Object.keys(committed[section]), ...Object.keys(installed[section])])
    for (const name of [...names].sort()) {
      const before = committed[section][name]
      const after = installed[section][name]
      if (before === undefined) {
        lines.push(`+ ${section}.${name} (novo no Codex instalado)`)
      } else if (after === undefined) {
        lines.push(`- ${section}.${name} (ausente no Codex instalado)`)
      } else if (JSON.stringify(before) !== JSON.stringify(after)) {
        const left = flatten(before, '', new Map())
        const right = flatten(after, '', new Map())
        for (const path of [...new Set([...left.keys(), ...right.keys()])].sort()) {
          if (left.get(path) !== right.get(path)) {
            lines.push(
              `~ ${section}.${name}.${path}: versionado=${left.get(path) ?? '(ausente)'} instalado=${right.get(path) ?? '(ausente)'}`,
            )
          }
        }
      }
    }
  }
  return lines
}

function run() {
  const version = readInstalledVersion()
  assertMinimumVersion(version)
  const subset = withGeneratedSchema(buildSubset)
  const manifest = buildManifest(subset, version)
  if (manifest.subsetBytes > SUBSET_SIZE_LIMIT_BYTES) {
    throw new Error(`Subconjunto com ${manifest.subsetBytes} bytes passa de 300 KB`)
  }
  writeFileSync(SUBSET_PATH, serializeSubset(subset))
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`)
  process.stdout.write(
    `Codex ${version}: ${manifest.methods.length} métodos, ${Object.keys(subset.definitions).length} definições, ${manifest.subsetBytes} bytes\n`,
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run()
}
