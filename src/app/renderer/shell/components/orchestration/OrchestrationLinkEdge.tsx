import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react'
import { Button } from '@app/renderer/components/ui/Button'
import { useTranslation } from '@app/renderer/i18n'
import {
  orchestrationLinkSelection,
  useOrchestrationLinkSelectionState,
} from '@contexts/orchestration/presentation/renderer'

export interface OrchestrationLinkEdgeData {
  readonly linkId: string
  readonly kind: 'executor' | 'peer'
  /** Title of the executor node, shown in the selected chip. */
  readonly targetTitle: string
  readonly roundsLimit: number
}

function dataOf(edgeId: string, data: unknown): OrchestrationLinkEdgeData {
  const parsed = (data ?? {}) as Partial<OrchestrationLinkEdgeData>
  return {
    linkId: parsed.linkId ?? edgeId.replace(/^orch-link-/, ''),
    kind: parsed.kind === 'peer' ? 'peer' : 'executor',
    targetTitle: parsed.targetTitle ?? '',
    roundsLimit: parsed.roundsLimit ?? 1,
  }
}

/**
 * Arrow of an active orchestration link. The label only exists while the edge is selected; the
 * Delete key never closes a link, the button of this label is the only way in.
 */
export function OrchestrationLinkEdge({
  id,
  sourceX,
  sourceY,
  sourcePosition,
  targetX,
  targetY,
  targetPosition,
  markerEnd,
  markerStart,
  label,
  selected,
  data,
}: EdgeProps): React.JSX.Element {
  const { t } = useTranslation()
  const { linkId, targetTitle, roundsLimit } = dataOf(id, data)
  const selection = useOrchestrationLinkSelectionState(state => state)
  const closing = selection.closingLinkId === linkId
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  })

  const stop = (event: React.SyntheticEvent): void => {
    event.stopPropagation()
  }

  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} markerStart={markerStart} />
      <EdgeLabelRenderer>
        {selected && !closing ? (
          <div
            className="workspace-orchestration-edge__chip nodrag nopan"
            data-testid={`orchestration-link-label-${linkId}`}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            onPointerDown={stop}
            onClick={stop}
          >
            {targetTitle ? (
              <span className="workspace-orchestration-edge__chip-title">{targetTitle}</span>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              className="workspace-orchestration-edge__chip-action"
              data-testid={`orchestration-link-close-${linkId}`}
              onClick={event => {
                event.stopPropagation()
                orchestrationLinkSelection.requestClose(linkId)
              }}
            >
              {t('orchestration.link.closeAction')}
            </Button>
          </div>
        ) : null}
        {!closing && label ? (
          <div
            className="workspace-orchestration-edge__label nodrag nopan"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY + 26}px)` }}
          >
            {label}
          </div>
        ) : null}
        {closing ? (
          <div
            className="workspace-orchestration-edge__popover nodrag nopan"
            data-testid={`orchestration-link-close-popover-${linkId}`}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            tabIndex={-1}
            ref={node => node?.focus()}
            onPointerDown={stop}
            onClick={stop}
            onKeyDown={event => {
              if (event.key === 'Escape') {
                event.stopPropagation()
                orchestrationLinkSelection.cancelClose()
              }
            }}
          >
            {selection.phase === 'force' ? (
              <>
                <p className="workspace-orchestration-edge__popover-title">
                  {t('orchestration.link.closeForceBody', {
                    target: targetTitle,
                    round: selection.blocking?.round ?? 0,
                    limit: roundsLimit,
                  })}
                </p>
                <p className="workspace-orchestration-edge__popover-body">
                  {t('orchestration.link.closeForceWarning')}
                </p>
                <div className="workspace-orchestration-edge__popover-actions">
                  <Button
                    variant="danger"
                    size="sm"
                    data-testid={`orchestration-link-close-force-${linkId}`}
                    disabled={selection.inFlight}
                    onClick={event => {
                      event.stopPropagation()
                      void orchestrationLinkSelection.forceClose()
                    }}
                  >
                    {t('orchestration.link.closeForce')}
                  </Button>
                  <Button
                    size="sm"
                    data-testid={`orchestration-link-close-cancel-${linkId}`}
                    disabled={selection.inFlight}
                    onClick={event => {
                      event.stopPropagation()
                      orchestrationLinkSelection.cancelClose()
                    }}
                  >
                    {t('orchestration.link.closeCancel')}
                  </Button>
                </div>
              </>
            ) : (
              <>
                <p className="workspace-orchestration-edge__popover-title">
                  {t('orchestration.link.closeTitle', { target: targetTitle })}
                </p>
                <p className="workspace-orchestration-edge__popover-body">
                  {t('orchestration.link.closeBody')}
                </p>
                <div className="workspace-orchestration-edge__popover-actions">
                  <Button
                    variant="danger"
                    size="sm"
                    data-testid={`orchestration-link-close-confirm-${linkId}`}
                    disabled={selection.inFlight}
                    onClick={event => {
                      event.stopPropagation()
                      void orchestrationLinkSelection.confirmClose()
                    }}
                  >
                    {t('orchestration.link.closeConfirm')}
                  </Button>
                  <Button
                    size="sm"
                    data-testid={`orchestration-link-close-cancel-${linkId}`}
                    disabled={selection.inFlight}
                    onClick={event => {
                      event.stopPropagation()
                      orchestrationLinkSelection.cancelClose()
                    }}
                  >
                    {t('orchestration.link.closeCancel')}
                  </Button>
                </div>
              </>
            )}
            {selection.errorCode ? (
              <p
                className="workspace-orchestration-edge__popover-error"
                data-testid={`orchestration-link-close-error-${linkId}`}
              >
                {t('orchestration.link.closeError')}
              </p>
            ) : null}
          </div>
        ) : null}
      </EdgeLabelRenderer>
    </>
  )
}
