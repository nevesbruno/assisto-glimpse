import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const PRELOAD_ENTRY = resolve(__dirname, '../../../src/app/preload/index.ts')
const SANDBOX_ALLOWED_PACKAGES = new Set(['electron'])

function isTypeOnlyImport(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause
  if (!clause) {
    return false
  }
  if (clause.isTypeOnly) {
    return true
  }
  const named = clause.namedBindings
  return (
    !clause.name &&
    !!named &&
    ts.isNamedImports(named) &&
    named.elements.length > 0 &&
    named.elements.every(element => element.isTypeOnly)
  )
}

function runtimeSpecifiers(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const specifiers: string[] = []
  for (const node of source.statements) {
    if (ts.isImportDeclaration(node) && !isTypeOnlyImport(node)) {
      specifiers.push((node.moduleSpecifier as ts.StringLiteral).text)
    }
    if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier) {
      specifiers.push((node.moduleSpecifier as ts.StringLiteral).text)
    }
  }
  return specifiers
}

function resolveRelative(from: string, specifier: string): string {
  const base = resolve(dirname(from), specifier)
  const candidates = [`${base}.ts`, `${base}.tsx`, resolve(base, 'index.ts'), base]
  const found = candidates.find(candidate => existsSync(candidate) && candidate.endsWith('.ts'))
  if (!found) {
    throw new Error(`Unresolved import ${specifier} from ${from}`)
  }
  return found
}

const REPO_ROOT = resolve(__dirname, '../../..')

function chainOf(file: string, importedBy: Map<string, string>): string[] {
  const chain = [file]
  for (let parent = importedBy.get(file); parent; parent = importedBy.get(parent)) {
    chain.unshift(parent)
  }
  return chain.map(item => item.replace(`${REPO_ROOT}/`, ''))
}

function collectBarePackages(entry: string): string[] {
  const seen = new Set<string>()
  const importedBy = new Map<string, string>()
  const offenders: string[] = []
  const pending = [entry]
  while (pending.length > 0) {
    const file = pending.pop() as string
    if (seen.has(file)) {
      continue
    }
    seen.add(file)
    for (const specifier of runtimeSpecifiers(file)) {
      if (specifier.startsWith('.')) {
        const target = resolveRelative(file, specifier)
        if (!importedBy.has(target)) {
          importedBy.set(target, file)
        }
        pending.push(target)
      } else if (!SANDBOX_ALLOWED_PACKAGES.has(specifier)) {
        offenders.push(`${[...chainOf(file, importedBy), specifier].join(' -> ')}`)
      }
    }
  }
  return offenders
}

describe('preload sandbox', () => {
  it('only requires electron from the preload import graph', () => {
    expect(collectBarePackages(PRELOAD_ENTRY)).toEqual([])
  })
})
