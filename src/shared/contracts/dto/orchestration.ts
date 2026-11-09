import * as z from 'zod'

export const ORCHESTRATION_ERROR_CODES = [
  'orch.forbidden',
  'orch.not_linked',
  'orch.link_invalid',
  'orch.executor_unavailable',
  'orch.round_limit_reached',
  'orch.dispatch_conflict',
  'orch.dispatch_in_flight',
  'orch.limit_reached',
  'orch.protocol_mismatch',
  'orch.approval_not_found',
  'orch.use_dispatch',
  'orch.link_declined',
  'orch.message_limit_reached',
] as const

export const ORCHESTRATION_TEXT_MAX_BYTES = 32_768

const ALLOWED_CONTROLS = new Set(['\t', '\n', '\r'])

export function hasForbiddenControlCharacter(value: string): boolean {
  for (const char of value) {
    if (/\p{Cc}/u.test(char) && !ALLOWED_CONTROLS.has(char)) {
      return true
    }
  }
  return false
}

export const orchestrationTextSchema = z
  .string()
  .refine(value => value.isWellFormed(), 'Text must be valid Unicode')
  .refine(
    value => !hasForbiddenControlCharacter(value),
    'Control characters other than tab and newline are refused',
  )
  .refine(value => {
    const bytes = Buffer.byteLength(value, 'utf8')
    return bytes >= 1 && bytes <= ORCHESTRATION_TEXT_MAX_BYTES
  }, `Text must be 1..${ORCHESTRATION_TEXT_MAX_BYTES} UTF-8 bytes`)

export const orchestrationLinkKindSchema = z.enum(['executor', 'peer'])
export const orchestrationLinkOriginSchema = z.enum([
  'orchestrator_spawn',
  'conversation_request',
  'canvas_manual',
])
export const orchestrationLinkStateSchema = z.enum(['requested', 'active', 'closed'])
export const orchestrationLinkCloseReasonSchema = z.enum([
  'orchestrator',
  'user',
  'node_deleted',
  'spawn_failed',
  'declined',
])
export const orchestrationLinkHealthSchema = z.enum([
  'starting',
  'ready',
  'busy',
  'degraded',
  'unavailable',
])
export const orchestrationRuntimeModeSchema = z.enum(['service', 'terminal'])
export const orchestrationDispatchStateSchema = z.enum([
  'queued',
  'reserved',
  'sent',
  'uncertain',
  'completed',
  'failed',
  'cancelled',
])

export const orchestrationLinkDtoSchema = z.strictObject({
  id: z.uuid(),
  projectId: z.string().min(1),
  spaceId: z.string().min(1),
  orchestratorNodeId: z.string().min(1),
  executorNodeId: z.string().min(1),
  kind: orchestrationLinkKindSchema,
  origin: orchestrationLinkOriginSchema,
  runtimeMode: orchestrationRuntimeModeSchema,
  provider: z.string().min(1),
  state: orchestrationLinkStateSchema,
  closeReason: orchestrationLinkCloseReasonSchema.nullable(),
  health: orchestrationLinkHealthSchema,
  roundsUsed: z.number().int().min(0),
  roundsLimit: z.number().int().min(1),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  revision: z.number().int().min(0),
})

export const orchestrationLinksMirrorSchema = z.strictObject({
  linksRevision: z.number().int().min(0),
  links: z.array(orchestrationLinkDtoSchema),
})

export type OrchestrationLinkDto = z.infer<typeof orchestrationLinkDtoSchema>
export type OrchestrationLinksMirror = z.infer<typeof orchestrationLinksMirrorSchema>
export type OrchestrationDispatchState = z.infer<typeof orchestrationDispatchStateSchema>
export type OrchestrationLinkHealth = z.infer<typeof orchestrationLinkHealthSchema>
