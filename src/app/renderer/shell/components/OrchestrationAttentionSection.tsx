import React, { useEffect, useId, useMemo } from 'react'
import { useStore } from 'zustand'
import { Button } from '@app/renderer/components/ui/Button'
import { PlayIcon } from '@app/renderer/components/ui/pixelIcons'
import { useTranslation } from '@app/renderer/i18n'
import { useAppStore } from '../store/useAppStore'
import {
  attentionItemCount,
  orchestrationAttention,
} from '@contexts/orchestration/presentation/renderer/orchestrationAttentionStore'

/** Titles come from the open workspaces, the only place a node title is known to the shell. */
export function useExecutorTitles(): Map<string, string> {
  const workspaces = useAppStore(state => state.workspaces)
  return useMemo(() => {
    const titles = new Map<string, string>()
    for (const workspace of workspaces) {
      for (const node of workspace.nodes) {
        const title = (node.data as { title?: unknown }).title
        if (typeof title === 'string' && title.length > 0) {
          titles.set(node.id, title)
        }
      }
    }
    return titles
  }, [workspaces])
}

function executorLabel(titles: Map<string, string>, executorNodeId: string): string {
  return titles.get(executorNodeId) ?? executorNodeId
}

export function OrchestrationAttentionSection({
  onOpen,
}: {
  /** Opens the shared window focused on one executor. */
  onOpen: (executorNodeId: string) => void
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const titleId = useId()
  const links = useStore(orchestrationAttention.store, state => state.links)
  const errorCode = useStore(orchestrationAttention.store, state => state.errorCode)
  const closedCode = useStore(orchestrationAttention.store, state => state.closedCode)
  const titles = useExecutorTitles()

  useEffect(() => {
    if (closedCode === null) {
      void orchestrationAttention.refresh()
    }
  }, [closedCode])

  if (closedCode !== null) {
    return null
  }

  if (errorCode !== null) {
    return (
      <section
        className="control-center__section"
        aria-labelledby={`${titleId}-unavailable`}
        data-testid="control-center-approvals"
      >
        <h3 id={`${titleId}-unavailable`} className="control-center__section-label">
          {t('orchestration.approvals.sectionLabel')}
        </h3>
        <p className="control-center__theme-status" data-testid="control-center-approvals-reason">
          {t(
            errorCode === 'orch.forbidden'
              ? 'orchestration.approvals.forbidden'
              : 'orchestration.approvals.unavailable',
          )}
        </p>
      </section>
    )
  }

  const pending = links.filter(link => link.approvals.length + link.hooks.length > 0)
  if (pending.length === 0) {
    return null
  }

  return (
    <section
      className="control-center__section"
      aria-labelledby={`${titleId}-label`}
      data-testid="control-center-approvals"
    >
      <h3 id={`${titleId}-label`} className="control-center__section-label">
        {t('orchestration.approvals.sectionLabel')}
      </h3>
      <div>
        {pending.map(link => {
          const count = attentionItemCount([link])
          return (
            <Button
              key={link.executorNodeId}
              variant="ghost"
              size="sm"
              className="control-center__link"
              data-testid={`control-center-approvals-open-${link.executorNodeId}`}
              onClick={() => onOpen(link.executorNodeId)}
            >
              <span className="control-center__link-cursor" aria-hidden="true">
                <PlayIcon size={12} />
              </span>
              <span className="control-center__link-label">
                {executorLabel(titles, link.executorNodeId)}
              </span>
              <span
                className="control-center__link-trailing"
                data-testid={`control-center-approvals-count-${link.executorNodeId}`}
              >
                {t('orchestration.approvals.pendingCount', { count })}
              </span>
            </Button>
          )
        })}
      </div>
    </section>
  )
}
