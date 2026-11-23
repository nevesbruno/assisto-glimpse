import { z } from 'zod'

const idSchema = z.string()
const requestIdSchema = z.union([z.string(), z.number()])

const threadItemSchema = z.looseObject({
  type: z.string(),
  id: idSchema,
  clientId: z.string().nullish(),
  text: z.string().optional(),
})

const turnSchema = z.looseObject({
  id: idSchema,
  status: z.enum(['completed', 'interrupted', 'failed', 'inProgress']),
  items: z.array(threadItemSchema).optional(),
})

const threadSchema = z.looseObject({ id: idSchema })

const hookMetadataSchema = z.looseObject({
  key: z.string(),
  currentHash: z.string(),
  trustStatus: z.enum(['managed', 'untrusted', 'trusted', 'modified']),
  eventName: z.string(),
})

const approvalParamsSchema = z.looseObject({
  threadId: idSchema,
  turnId: idSchema,
  itemId: idSchema,
})

const approvalResponseSchema = z.looseObject({ decision: z.unknown() })

/** Campos que o adaptador lê, por nome de definição do subconjunto. Campo novo do Codex é tolerado. */
export const codexReadSchemas = {
  InitializeResponse: z.looseObject({ userAgent: z.string() }),
  ThreadStartResponse: z.looseObject({ thread: threadSchema }),
  ThreadResumeResponse: z.looseObject({ thread: threadSchema }),
  TurnStartResponse: z.looseObject({ turn: turnSchema }),
  ThreadTurnsListResponse: z.looseObject({
    data: z.array(turnSchema),
    nextCursor: z.string().nullish(),
  }),
  ThreadStartedNotification: z.looseObject({ thread: threadSchema }),
  ThreadStatusChangedNotification: z.looseObject({ threadId: idSchema }),
  TurnStartedNotification: z.looseObject({ threadId: idSchema, turn: turnSchema }),
  TurnCompletedNotification: z.looseObject({ threadId: idSchema, turn: turnSchema }),
  ItemCompletedNotification: z.looseObject({
    threadId: idSchema,
    turnId: idSchema,
    item: threadItemSchema,
  }),
  ServerRequestResolvedNotification: z.looseObject({
    threadId: idSchema,
    requestId: requestIdSchema,
  }),
  HooksListResponse: z.looseObject({
    data: z.array(z.looseObject({ cwd: z.string(), hooks: z.array(hookMetadataSchema) })),
  }),
  HookCompletedNotification: z.looseObject({
    threadId: idSchema,
    run: z.looseObject({ eventName: z.string(), status: z.string() }),
  }),
  CommandExecutionRequestApprovalParams: approvalParamsSchema,
  FileChangeRequestApprovalParams: approvalParamsSchema,
  CommandExecutionRequestApprovalResponse: approvalResponseSchema,
  FileChangeRequestApprovalResponse: approvalResponseSchema,
} as const

export type CodexReadDefinition = keyof typeof codexReadSchemas
export type CodexThreadTurn = z.infer<typeof turnSchema>
export type CodexHookMetadata = z.infer<typeof hookMetadataSchema>

interface JsonSchemaNode {
  $ref?: string
  type?: string | string[]
  enum?: unknown[]
  properties?: Record<string, JsonSchemaNode>
  items?: JsonSchemaNode
  anyOf?: JsonSchemaNode[]
  oneOf?: JsonSchemaNode[]
  allOf?: JsonSchemaNode[]
}

export interface CodexProtocolSubset {
  methods: Record<string, { kind: string; params?: string; response?: string }>
  definitions: Record<string, JsonSchemaNode>
}

interface ZodDef {
  type: string
  innerType?: z.ZodType
  element?: z.ZodType
  shape?: Record<string, z.ZodType>
  options?: z.ZodType[]
}

const zodDef = (schema: z.ZodType): ZodDef =>
  (schema as unknown as { _zod: { def: ZodDef } })._zod.def

function resolveNodes(
  definitions: CodexProtocolSubset['definitions'],
  node: JsonSchemaNode,
  seen = new Set<string>(),
): JsonSchemaNode[] {
  if (node.$ref) {
    const name = node.$ref.slice(node.$ref.lastIndexOf('/') + 1)
    const target = definitions[name]
    if (!target || seen.has(name)) {
      return []
    }
    return resolveNodes(definitions, target, new Set(seen).add(name))
  }
  const variants = [...(node.anyOf ?? []), ...(node.oneOf ?? []), ...(node.allOf ?? [])]
  const own = node.properties || node.items || node.type || node.enum ? [node] : []
  return [...own, ...variants.flatMap(variant => resolveNodes(definitions, variant, seen))]
}

function schemaTypes(nodes: JsonSchemaNode[]): Set<string> {
  const types = new Set<string>()
  for (const node of nodes) {
    for (const type of [node.type ?? []].flat()) {
      types.add(type === 'integer' ? 'number' : type)
    }
    if (node.enum?.every(value => typeof value === 'string')) {
      types.add('string')
    }
  }
  return types
}

function checkField(
  definitions: CodexProtocolSubset['definitions'],
  schema: z.ZodType,
  nodes: JsonSchemaNode[],
  path: string,
  issues: string[],
): void {
  const def = zodDef(schema)
  if (def.type === 'optional' || def.type === 'nullable') {
    checkField(definitions, def.innerType as z.ZodType, nodes, path, issues)
  } else if (def.type === 'array') {
    const items = nodes.flatMap(node => (node.items ? resolveNodes(definitions, node.items) : []))
    if (items.length === 0) {
      issues.push(`${path}: campo lido não é lista no subconjunto`)
    } else {
      checkField(definitions, def.element as z.ZodType, items, `${path}[]`, issues)
    }
  } else if (def.type === 'object') {
    for (const [key, child] of Object.entries(def.shape ?? {})) {
      const childNodes = nodes.flatMap(node =>
        node.properties?.[key] ? resolveNodes(definitions, node.properties[key]) : [],
      )
      if (childNodes.length === 0) {
        issues.push(`${path}.${key}: campo lido ausente no subconjunto`)
      } else {
        checkField(definitions, child, childNodes, `${path}.${key}`, issues)
      }
    }
  } else if (def.type === 'union') {
    const accepted = schemaTypes(nodes)
    const missing = (def.options ?? []).filter(option => !accepted.has(zodDef(option).type))
    if (missing.length === (def.options ?? []).length) {
      issues.push(
        `${path}: nenhum tipo lido (${(def.options ?? []).map(o => zodDef(o).type)}) existe no subconjunto (${[...accepted]})`,
      )
    }
  } else if (['string', 'number', 'boolean', 'enum'].includes(def.type)) {
    const expected = def.type === 'enum' ? 'string' : def.type
    const accepted = schemaTypes(nodes)
    if (!accepted.has(expected)) {
      issues.push(
        `${path}: tipo lido ${expected}, subconjunto tem ${[...accepted].join('|') || '(nenhum)'}`,
      )
    }
  }
}

/** Devolve uma linha legível por campo lido que sumiu ou mudou de tipo no subconjunto. */
export function findMissingReadFields(subset: CodexProtocolSubset): string[] {
  const issues: string[] = []
  for (const [name, schema] of Object.entries(codexReadSchemas)) {
    const root = subset.definitions[name]
    if (!root) {
      issues.push(`${name}: definição ausente no subconjunto`)
      continue
    }
    checkField(subset.definitions, schema, resolveNodes(subset.definitions, root), name, issues)
  }
  return issues
}
