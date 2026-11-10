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

const roundSchema = z.number().int().min(1)
const countSchema = z.number().int().min(0)

export const orchestrationDispatchFailureReasonSchema = z.enum([
  'not_sent',
  'executor_down',
  'turn_failed',
  'interrupted',
])
export const orchestrationDispatchOutcomeSchema = z.enum(['completed', 'failed', 'interrupted'])
export const orchestrationAdmissionReasonSchema = z.enum([
  'round_limit_reached',
  'executor_unavailable',
  'dispatch_in_flight',
])

export const orchestrationBlockingDispatchSchema = z.strictObject({
  dispatchId: z.uuid(),
  state: z.enum(['queued', 'reserved', 'sent', 'uncertain']),
  round: roundSchema,
})

export const orchestrationAdmissionSchema = z
  .strictObject({
    canDispatch: z.boolean(),
    reason: orchestrationAdmissionReasonSchema.nullable(),
    blocking: orchestrationBlockingDispatchSchema.nullable(),
    willWait: z.boolean(),
  })
  .refine(a => a.canDispatch === (a.reason === null), 'reason is null if and only if canDispatch')
  .refine(a => !a.willWait || a.canDispatch, 'willWait requires canDispatch')
  .refine(
    a => (a.blocking !== null) === (a.reason === 'dispatch_in_flight'),
    'blocking exists if and only if reason is dispatch_in_flight',
  )

export const orchestrationDispatchAcceptedSchema = z.strictObject({
  dispatchId: z.uuid(),
  state: orchestrationDispatchStateSchema,
  round: roundSchema,
  roundsLimit: roundSchema,
})

export const orchestrationDispatchViewSchema = z
  .strictObject({
    dispatchId: z.uuid(),
    state: orchestrationDispatchStateSchema,
    round: roundSchema,
    reason: orchestrationDispatchFailureReasonSchema.nullable(),
    outcome: orchestrationDispatchOutcomeSchema.nullable(),
    createdAt: z.string().min(1),
    deadlineAt: z.string().min(1),
    finishedAt: z.string().min(1).nullable(),
  })
  .refine(
    v => (v.reason !== null) === (v.state === 'failed'),
    'reason exists if and only if state is failed',
  )

export const orchestrationDispatchResultSchema = orchestrationDispatchAcceptedSchema.extend({
  duplicate: z.boolean(),
  admission: orchestrationAdmissionSchema,
})

export const orchestrationSpawnResultSchema = z.strictObject({
  executorNodeId: z.string().min(1),
  linkId: z.uuid(),
  runtimeMode: orchestrationRuntimeModeSchema,
  duplicate: z.boolean(),
  dispatch: orchestrationDispatchAcceptedSchema.nullable(),
  admission: orchestrationAdmissionSchema,
})

export const orchestrationStatusLinkSchema = z.strictObject({
  linkId: z.uuid(),
  executorNodeId: z.string().min(1),
  title: z.string(),
  provider: z.string().min(1),
  runtimeMode: orchestrationRuntimeModeSchema,
  health: orchestrationLinkHealthSchema,
  roundsUsed: countSchema,
  roundsLimit: roundSchema,
  admission: orchestrationAdmissionSchema,
  current: orchestrationDispatchViewSchema.nullable(),
  last: orchestrationDispatchViewSchema.nullable(),
  pendingApprovals: countSchema,
  pendingHooks: countSchema,
  notices: z.strictObject({ pending: countSchema, uncertain: countSchema }),
})

export const orchestrationStatusResultSchema = z.strictObject({
  linksRevision: countSchema,
  links: z.array(orchestrationStatusLinkSchema),
})

export const orchestrationHooksApproveResultSchema = z.strictObject({
  approved: countSchema,
  restart: z.enum(['done', 'scheduled']),
})

export type OrchestrationHooksApproveResult = z.infer<typeof orchestrationHooksApproveResultSchema>
export type OrchestrationAdmission = z.infer<typeof orchestrationAdmissionSchema>
export type OrchestrationDispatchView = z.infer<typeof orchestrationDispatchViewSchema>
export type OrchestrationDispatchResult = z.infer<typeof orchestrationDispatchResultSchema>
export type OrchestrationSpawnResult = z.infer<typeof orchestrationSpawnResultSchema>
export type OrchestrationStatusResult = z.infer<typeof orchestrationStatusResultSchema>
