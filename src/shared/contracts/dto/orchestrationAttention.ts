import * as z from 'zod'

/** The Worker cuts every approval summary to this many characters before it leaves the process. */
export const ORCHESTRATION_ATTENTION_SUMMARY_MAX = 500

const countSchema = z.number().int().min(0)

export const orchestrationPendingApprovalSchema = z.strictObject({
  requestId: z.string().min(1),
  kind: z.string(),
  summary: z.string().max(ORCHESTRATION_ATTENTION_SUMMARY_MAX),
  turnRef: z.string().min(1).nullable(),
})

export const orchestrationPendingHookSchema = z.strictObject({
  key: z.string().min(1),
  event: z.string(),
  origin: z.string(),
  currentHash: z.string().min(1),
})

export const orchestrationAttentionLinkSchema = z.strictObject({
  executorNodeId: z.string().min(1),
  approvals: z.array(orchestrationPendingApprovalSchema),
  hooks: z.array(orchestrationPendingHookSchema),
})

export const orchestrationAttentionResultSchema = z.strictObject({
  linksRevision: countSchema,
  links: z.array(orchestrationAttentionLinkSchema),
})

export type OrchestrationPendingApprovalDto = z.infer<typeof orchestrationPendingApprovalSchema>
export type OrchestrationPendingHookDto = z.infer<typeof orchestrationPendingHookSchema>
export type OrchestrationAttentionLinkDto = z.infer<typeof orchestrationAttentionLinkSchema>
export type OrchestrationAttentionResult = z.infer<typeof orchestrationAttentionResultSchema>
