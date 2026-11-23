import * as z from 'zod'
import { defineOperation } from '../defineOperation'

const executorNodeId = z.string().trim().min(1)

export const orchApprovalListOperation = defineOperation({
  id: 'orch.approval.list',
  kind: 'query',
  scope: 'interact',
  availability: 'always',
  summary: 'List the pending executor approvals and the hooks waiting for trust',
  errors: ['orch.forbidden', 'orch.not_linked'],
  input: z.strictObject({
    executorNodeId: executorNodeId
      .optional()
      .describe('Executor node to inspect; the user sees every linked executor without it'),
  }),
})

export const orchAttentionOperations = [orchApprovalListOperation] as const
