import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  findMissingReadFields,
  type CodexProtocolSubset,
} from '../../../src/contexts/orchestration/infrastructure/codex/protocol/codexProtocol'

interface Extractor {
  MIN_CODEX_VERSION: string
  readInstalledVersion: () => string
  assertMinimumVersion: (version: string) => void
  withGeneratedSchema: <T>(callback: (schemaDir: string) => T) => T
  buildSubset: (schemaDir: string) => CodexProtocolSubset
  diffSubsets: (committed: CodexProtocolSubset, installed: CodexProtocolSubset) => string[]
}

const PROTOCOL_DIR = resolve(
  __dirname,
  '../../../src/contexts/orchestration/infrastructure/codex/protocol',
)
const loadExtractor = async (): Promise<Extractor> =>
  (await import(
    pathToFileURL(resolve(__dirname, '../../../scripts/codex-protocol/extract-subset.mjs')).href
  )) as Extractor

const committed = JSON.parse(
  readFileSync(resolve(PROTOCOL_DIR, 'codex-protocol.subset.json'), 'utf8'),
) as CodexProtocolSubset

describe.skipIf(process.env['OPENCOVE_TEST_REAL_CODEX'] !== '1')(
  'C-04 subconjunto contra o Codex instalado',
  () => {
    it('versão instalada atende a mínima e versão abaixo falha com mensagem clara', async () => {
      const extractor = await loadExtractor()
      expect(() => extractor.assertMinimumVersion(extractor.readInstalledVersion())).not.toThrow()
      expect(() => extractor.assertMinimumVersion('0.166.9')).toThrow(
        /abaixo da versão mínima 0\.167\.0/,
      )
    })

    it('subconjunto regenerado pelo Codex instalado é igual ao versionado', async () => {
      const extractor = await loadExtractor()
      const installed = extractor.withGeneratedSchema(extractor.buildSubset)
      expect(extractor.diffSubsets(committed, installed).join('\n')).toBe('')
    })

    it('campos lidos pelo zod existem no esquema gerado pelo Codex instalado', async () => {
      const extractor = await loadExtractor()
      const installed = extractor.withGeneratedSchema(extractor.buildSubset)
      expect(findMissingReadFields(installed).join('\n')).toBe('')
    })
  },
)
