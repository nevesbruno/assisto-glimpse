import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  codexReadSchemas,
  findMissingReadFields,
  type CodexProtocolSubset,
} from '../../../src/contexts/orchestration/infrastructure/codex/protocol/codexProtocol'

const PROTOCOL_DIR = resolve(
  __dirname,
  '../../../src/contexts/orchestration/infrastructure/codex/protocol',
)
const FIXTURES_DIR = resolve(__dirname, '../../fixtures/codex-protocol')

const subsetText = readFileSync(join(PROTOCOL_DIR, 'codex-protocol.subset.json'), 'utf8')
const subset = JSON.parse(subsetText) as CodexProtocolSubset
const manifest = JSON.parse(readFileSync(join(PROTOCOL_DIR, 'manifest.json'), 'utf8')) as {
  codexVersion: string
  minCodexVersion: string
  methods: string[]
  subsetBytes: number
  subsetSha256: string
  definitionHashes: Record<string, string>
}

interface Fixture {
  definition: string
  message: unknown
}

const fixtures = readdirSync(FIXTURES_DIR)
  .filter(name => name.endsWith('.json'))
  .flatMap(name =>
    (JSON.parse(readFileSync(join(FIXTURES_DIR, name), 'utf8')) as Fixture[]).map(fixture => ({
      file: name,
      ...fixture,
    })),
  )

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

function subsetValidator(definition: string): z.ZodType {
  return z.fromJSONSchema({
    ...subset.definitions[definition],
    $schema: 'http://json-schema.org/draft-07/schema#',
    definitions: subset.definitions,
  } as never)
}

describe('C-03 subconjunto do protocolo Codex', () => {
  it('manifesto bate com versão mínima, métodos, tamanho e hashes do subconjunto', () => {
    expect(manifest.minCodexVersion).toBe('0.167.0')
    expect(manifest.methods).toEqual(Object.keys(subset.methods))
    expect(manifest.subsetBytes).toBe(Buffer.byteLength(subsetText))
    expect(manifest.subsetSha256).toBe(sha256(subsetText))
    expect(
      Object.fromEntries(
        Object.entries(subset.definitions).map(([name, definition]) => [
          name,
          sha256(JSON.stringify(definition)),
        ]),
      ),
    ).toEqual(manifest.definitionHashes)
  })

  it('subconjunto fica abaixo de 300 KB', () => {
    expect(manifest.subsetBytes).toBeLessThan(300 * 1024)
  })

  it('cada método tem as definições de params e response no subconjunto', () => {
    for (const [method, entry] of Object.entries(subset.methods)) {
      for (const name of [entry.params, entry.response].filter(Boolean) as string[]) {
        expect(subset.definitions[name], `${method} -> ${name}`).toBeDefined()
      }
    }
  })

  it('fixtures cobrem handshake, thread, turno, lista de turnos, aprovações e hooks/list', () => {
    expect(new Set(fixtures.map(fixture => fixture.file))).toEqual(
      new Set([
        'handshake.json',
        'thread.json',
        'turn.json',
        'turns-list.json',
        'approvals.json',
        'hooks-list.json',
      ]),
    )
  })

  it.each(fixtures.map(fixture => [`${fixture.file} ${fixture.definition}`, fixture] as const))(
    'fixture %s valida contra o subconjunto e contra o zod',
    (_label, fixture) => {
      expect(subset.definitions[fixture.definition]).toBeDefined()
      expect(subsetValidator(fixture.definition).safeParse(fixture.message).success).toBe(true)
      const readSchema = (codexReadSchemas as Record<string, z.ZodType>)[fixture.definition]
      if (readSchema) {
        expect(readSchema.safeParse(fixture.message).success).toBe(true)
      }
    },
  )

  it('zod aceita campo extra de versão nova e rejeita campo lido ausente', () => {
    const turn = { id: 't1', status: 'completed', futureField: { a: 1 } }
    expect(codexReadSchemas.TurnStartResponse.safeParse({ turn, other: 1 }).success).toBe(true)
    expect(
      codexReadSchemas.TurnStartResponse.safeParse({ turn: { status: 'completed' } }).success,
    ).toBe(false)
  })

  it('todo campo lido pelo zod existe no subconjunto com tipo compatível', () => {
    expect(findMissingReadFields(subset)).toEqual([])
  })

  it('subconjunto sem um campo lido produz diagnóstico legível', () => {
    const tampered = structuredClone(subset)
    delete (tampered.definitions.Turn.properties as Record<string, unknown>).id
    expect(findMissingReadFields(tampered)).toContain(
      'TurnStartResponse.turn.id: campo lido ausente no subconjunto',
    )
  })
})
