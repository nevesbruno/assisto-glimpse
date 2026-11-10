import type { RoundExtension } from '../../../../contexts/orchestration/domain/roundPolicy'
import { OrchestrationError } from '../../../../contexts/orchestration/domain/agentLink'
import {
  visibleLinks,
  type OrchestrationPrincipal,
} from '../../../../contexts/orchestration/domain/orchestrationAuthorization'
import {
  orchApprovalRespondOperation,
  orchCancelOperation,
  orchCloseOperation,
  orchDispatchOperation,
  orchHooksApproveOperation,
  orchInterruptOperation,
  orchLinkCloseOperation,
  orchLinkCreateOperation,
  orchLinkExtendOperation,
  orchLinkListOperation,
  orchSpawnOperation,
  orchStatusOperation,
} from '../../../../shared/contracts/controlSurface/operations/domains/orch'
import { createAppError } from '../../../../shared/errors/appError'
import type { ControlSurface } from '../controlSurface'
import { registerOperation } from '../registerOperation'
import type { ControlSurfaceContext } from '../types'
import {
  assertAuthorized,
  linkDtoOf,
  mapErrors,
  principalOf,
  type OrchestrationBackend,
  type OrchestrationHandlerDeps,
} from './orchestrationHandlers.support'

const OK = { ok: true } as const

export function registerOrchestrationHandlers(
  controlSurface: ControlSurface,
  deps: OrchestrationHandlerDeps,
): void {
  const handler = <Input, Result>(
    operation: (
      backend: OrchestrationBackend,
      principal: OrchestrationPrincipal,
      input: Input,
    ) => Promise<Result>,
  ) =>
    ({
      defaultErrorCode: 'common.unexpected',
      handle: (ctx: ControlSurfaceContext, input: Input): Promise<Result> =>
        mapErrors(async () => {
          const backend = deps.backend()
          if (!backend) {
            throw createAppError('common.unavailable')
          }
          return operation(backend, await principalOf(ctx, deps.providerOfNode), input)
        }),
    }) as const

  registerOperation(
    controlSurface,
    orchSpawnOperation,
    handler(({ service }, p, input) => service.spawn(p, input)),
  )
  registerOperation(
    controlSurface,
    orchDispatchOperation,
    handler(({ service }, p, input) => service.dispatch(p, input)),
  )
  registerOperation(
    controlSurface,
    orchStatusOperation,
    handler(({ service }, p, input) => service.status(p, input)),
  )
  registerOperation(
    controlSurface,
    orchCancelOperation,
    handler(({ service }, p, input) => service.cancel(p, input)),
  )
  registerOperation(
    controlSurface,
    orchInterruptOperation,
    handler(async ({ service }, p, input) => {
      await service.interrupt(p, input)
      return OK
    }),
  )
  registerOperation(
    controlSurface,
    orchCloseOperation,
    handler(async ({ service }, p, input) => {
      await service.close(p, input)
      return OK
    }),
  )
  registerOperation(
    controlSurface,
    orchLinkCreateOperation,
    handler(({ service }, p, input) => service.createLink(p, input)),
  )
  registerOperation(
    controlSurface,
    orchLinkCloseOperation,
    handler(async ({ service, links }, p, input) => {
      const link = await links.findById(input.linkId)
      await assertAuthorized(links, p, 'orch.link.close', link?.executorNodeId ?? null)
      if (!link) {
        throw new OrchestrationError('orch.not_linked')
      }
      await service.close(p, { to: link.executorNodeId, force: input.force })
      return OK
    }),
  )
  registerOperation(
    controlSurface,
    orchLinkListOperation,
    handler(async ({ service, links }, p, input) => {
      await assertAuthorized(links, p, 'orch.link.list', null)
      const listed = visibleLinks(p, await links.listByProject(input.projectId ?? null))
      return {
        linksRevision: await links.readLinksRevision(),
        links: listed.map(link => linkDtoOf(link, service.healthOf(link.executorNodeId))),
      }
    }),
  )
  registerOperation(
    controlSurface,
    orchLinkExtendOperation,
    handler(async ({ service }, p, input) => {
      const link = await service.extendRounds(p, {
        linkId: input.linkId,
        rounds: input.rounds as RoundExtension,
      })
      return { linkId: link.id, roundsLimit: link.roundsLimit }
    }),
  )
  registerOperation(
    controlSurface,
    orchApprovalRespondOperation,
    handler(async ({ service }, p, input) => {
      await service.respondApproval(p, input)
      return OK
    }),
  )
  registerOperation(
    controlSurface,
    orchHooksApproveOperation,
    handler(({ service }, p, input) => service.approveHooks(p, input)),
  )
}
