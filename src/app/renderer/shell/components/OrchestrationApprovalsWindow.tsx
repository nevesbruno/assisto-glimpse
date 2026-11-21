import React, { useEffect, useRef } from 'react'
import { useStore } from 'zustand'
import { Button } from '@app/renderer/components/ui/Button'
import { Dialog } from '@app/renderer/components/ui/Dialog'
import { IconButton } from '@app/renderer/components/ui/IconButton'
import { CloseIcon } from '@app/renderer/components/ui/pixelIcons'
import { useTranslation } from '@app/renderer/i18n'
import type {
  OrchestrationAttentionLinkDto,
  OrchestrationPendingApprovalDto,
} from '@shared/contracts/dto/orchestrationAttention'
import {
  approvalItemKey,
  hookItemKey,
  orchestrationAttention,
  type OrchestrationAttentionNotice,
  type OrchestrationApprovalAnswer,
} from '@contexts/orchestration/presentation/renderer/orchestrationAttentionStore'
import { useOrchestrationLinks } from '@contexts/orchestration/presentation/renderer/useOrchestrationLinks'
import { useExecutorTitles } from './OrchestrationAttentionSection'

const NOTICE_KEYS: Record<OrchestrationAttentionNotice['kind'], string> = {
  approval_already_answered: 'alreadyAnswered',
  hook_changed: 'hookChanged',
  hook_restart_scheduled: 'restartScheduled',
}

function Notice({ notice }: { notice: OrchestrationAttentionNotice }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <p
      role="status"
      className="cove-window__hint"
      data-testid="orchestration-approvals-notice"
      data-notice={notice.kind}
    >
      {t(`orchestration.approvals.${NOTICE_KEYS[notice.kind]}`)}
    </p>
  )
}

function ApprovalItem({
  executorNodeId,
  approval,
  busy,
  disabled,
}: {
  executorNodeId: string
  approval: OrchestrationPendingApprovalDto
  busy: boolean
  disabled: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const answer = (decision: OrchestrationApprovalAnswer) => {
    void orchestrationAttention.respondApproval({
      executorNodeId,
      requestId: approval.requestId,
      decision,
    })
  }
  return (
    <li
      className="cove-window__section-card"
      data-testid={`orchestration-approval-${approval.requestId}`}
    >
      <div className="cove-window__section-card-heading">
        <strong>{approval.summary}</strong>
        <span>
          {approval.kind}
          {approval.turnRef ? ` · ${approval.turnRef}` : ''}
        </span>
      </div>
      <div className="cove-window__section-card-actions">
        <Button
          variant="primary"
          size="sm"
          loading={busy}
          disabled={disabled}
          data-testid={`orchestration-approval-accept-${approval.requestId}`}
          onClick={() => answer('accept')}
        >
          {t('orchestration.approvals.approve')}
        </Button>
        <Button
          size="sm"
          disabled={disabled || busy}
          data-testid={`orchestration-approval-session-${approval.requestId}`}
          onClick={() => answer('acceptForSession')}
        >
          {t('orchestration.approvals.approveForSession')}
        </Button>
        <Button
          size="sm"
          disabled={disabled || busy}
          data-testid={`orchestration-approval-decline-${approval.requestId}`}
          onClick={() => answer('decline')}
        >
          {t('orchestration.approvals.decline')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled || busy}
          data-testid={`orchestration-approval-cancel-${approval.requestId}`}
          onClick={() => answer('cancel')}
        >
          {t('orchestration.approvals.cancelTurn')}
        </Button>
      </div>
    </li>
  )
}

function HookItem({
  executorNodeId,
  hook,
  busy,
  disabled,
}: {
  executorNodeId: string
  hook: OrchestrationAttentionLinkDto['hooks'][number]
  busy: boolean
  disabled: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <li
      className="cove-window__section-card"
      data-testid="orchestration-hook"
      data-hook-key={hook.key}
    >
      <div className="cove-window__section-card-heading">
        <strong>{t('orchestration.approvals.hookHeading')}</strong>
        <span>
          {hook.event} · {t('orchestration.approvals.hookOrigin', { origin: hook.origin })}
        </span>
      </div>
      <div className="cove-window__section-card-actions">
        <Button
          variant="primary"
          size="sm"
          loading={busy}
          disabled={disabled}
          data-testid="orchestration-hook-approve"
          onClick={() => {
            void orchestrationAttention.approveHook({ executorNodeId, key: hook.key })
          }}
        >
          {t('orchestration.approvals.approveHook')}
        </Button>
      </div>
    </li>
  )
}

/**
 * The one window for approvals and hook trust. It only reads `orch.approval.list` and calls the
 * two existing operations; the item leaves the list when the Worker no longer returns it.
 */
export function OrchestrationApprovalsWindow({
  isOpen,
  executorNodeId,
  onClose,
}: {
  isOpen: boolean
  /** Null shows every visible linked executor. */
  executorNodeId: string | null
  onClose: () => void
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const backRef = useRef<HTMLButtonElement | null>(null)
  const links = useStore(orchestrationAttention.store, state => state.links)
  const loaded = useStore(orchestrationAttention.store, state => state.loaded)
  const errorCode = useStore(orchestrationAttention.store, state => state.errorCode)
  const closedCode = useStore(orchestrationAttention.store, state => state.closedCode)
  const actionErrorCode = useStore(orchestrationAttention.store, state => state.actionErrorCode)
  const notice = useStore(orchestrationAttention.store, state => state.notice)
  const inFlight = useStore(orchestrationAttention.store, state => state.inFlight)
  const titles = useExecutorTitles()
  const mirrors = useOrchestrationLinks()

  useEffect(() => {
    if (isOpen) {
      orchestrationAttention.dismissNotice()
      void orchestrationAttention.refresh()
    }
  }, [isOpen])

  useEffect(() => {
    if (!isOpen) {
      return
    }
    const targetGone =
      loaded &&
      executorNodeId !== null &&
      !links.some(link => link.executorNodeId === executorNodeId)
    if (closedCode !== null || errorCode !== null || targetGone) {
      onClose()
    }
  }, [closedCode, errorCode, executorNodeId, isOpen, links, loaded, onClose])

  if (!isOpen) {
    return null
  }

  const healthById = new Map(mirrors.map(link => [link.executorNodeId, link.health] as const))
  const visible =
    executorNodeId === null ? links : links.filter(link => link.executorNodeId === executorNodeId)
  const busyOf = (key: string) => inFlight.includes(key)
  // An approval usually arrives during a turn, so a busy executor must still answer. Only the
  // states without a live service block the buttons.
  const healthDisables = (nodeId: string) => {
    const health = healthById.get(nodeId)
    return health === 'starting' || health === 'unavailable'
  }
  const total = visible.reduce(
    (count, link) => count + link.approvals.length + link.hooks.length,
    0,
  )

  return (
    <Dialog
      open={isOpen}
      aria-label={t('orchestration.approvals.windowTitle')}
      className="cove-window"
      backdropClassName="cove-window-backdrop"
      data-testid="orchestration-approvals-window"
      initialFocusRef={backRef}
      fallbackReturnFocusSelector='[data-testid="app-header-control-center"]'
      onDismiss={onClose}
    >
      <div className="cove-window__heading">
        <h3>{t('orchestration.approvals.windowTitle')}</h3>
        <IconButton
          className="cove-window__heading-close"
          label={t('common.close')}
          data-testid="orchestration-approvals-close"
          onClick={onClose}
        >
          <CloseIcon size={18} />
        </IconButton>
      </div>

      {notice !== null ? <Notice notice={notice} /> : null}
      {actionErrorCode !== null ? (
        <p className="cove-window__error" data-testid="orchestration-approvals-error">
          {t('orchestration.approvals.actionFailed')}
        </p>
      ) : null}

      {total === 0 ? (
        <p className="cove-window__hint" data-testid="orchestration-approvals-empty">
          {t('orchestration.approvals.empty')}
        </p>
      ) : (
        visible.map(link => {
          const disabled = healthDisables(link.executorNodeId)
          return (
            <section
              key={link.executorNodeId}
              className="cove-window__fields"
              aria-label={titles.get(link.executorNodeId) ?? link.executorNodeId}
              data-testid={`orchestration-approvals-executor-${link.executorNodeId}`}
            >
              <h4>{titles.get(link.executorNodeId) ?? link.executorNodeId}</h4>
              <ul className="cove-window__fields">
                {link.approvals.map(approval => (
                  <ApprovalItem
                    key={approval.requestId}
                    executorNodeId={link.executorNodeId}
                    approval={approval}
                    busy={busyOf(approvalItemKey(link.executorNodeId, approval.requestId))}
                    disabled={disabled}
                  />
                ))}
                {link.hooks.map(hook => (
                  <HookItem
                    key={hook.key}
                    executorNodeId={link.executorNodeId}
                    hook={hook}
                    busy={busyOf(hookItemKey(link.executorNodeId, hook.key))}
                    disabled={disabled}
                  />
                ))}
              </ul>
            </section>
          )
        })
      )}

      <div className="cove-window__actions">
        <Button
          ref={backRef}
          variant="ghost"
          className="cove-window__action cove-window__action--ghost"
          data-testid="orchestration-approvals-back"
          onClick={onClose}
        >
          {t('orchestration.approvals.back')}
        </Button>
      </div>
    </Dialog>
  )
}
