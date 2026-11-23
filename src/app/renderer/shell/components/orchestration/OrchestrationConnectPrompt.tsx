import type * as React from 'react'
import { Button } from '@app/renderer/components/ui/Button'
import { useTranslation } from '@app/renderer/i18n'

export interface OrchestrationConnectPromptInput {
  readonly hintKey: string | null
  readonly confirmation: {
    readonly sourceTitle: string
    readonly targetTitle: string
    readonly busy: boolean
    readonly reattach: boolean
    readonly inFlight: boolean
    readonly errorCode: string | null
  } | null
}

const ERROR_KEYS: Record<string, string> = {
  'orch.link_invalid': 'orchestration.connect.error.invalid',
  'orch.executor_unavailable': 'orchestration.connect.error.unavailable',
  'orch.protocol_mismatch': 'orchestration.connect.error.mismatch',
}

export function OrchestrationConnectPrompt({
  prompt,
  onAccept,
  onCancel,
}: {
  prompt: OrchestrationConnectPromptInput
  onAccept: () => void
  onCancel: () => void
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const { hintKey, confirmation } = prompt
  const stop = (event: React.SyntheticEvent): void => {
    event.stopPropagation()
  }

  if (!hintKey && !confirmation) {
    return null
  }

  return (
    <>
      {hintKey ? (
        <div
          className="workspace-orchestration-connect__hint"
          data-testid="orchestration-connect-hint"
          data-hint-key={hintKey}
          role="status"
          onClick={stop}
        >
          {t(hintKey)}
        </div>
      ) : null}
      {confirmation ? (
        <div
          className="workspace-orchestration-connect__confirm"
          data-testid="orchestration-connect-confirm"
          role="dialog"
          aria-modal="true"
          onClick={stop}
        >
          <p className="workspace-orchestration-connect__title">
            {t('orchestration.connect.title', {
              source: confirmation.sourceTitle,
              target: confirmation.targetTitle,
            })}
          </p>
          <p className="workspace-orchestration-connect__body">{t('orchestration.connect.body')}</p>
          {confirmation.reattach ? (
            <p className="workspace-orchestration-connect__body">
              {t('orchestration.connect.reattach')}
            </p>
          ) : null}
          {confirmation.busy ? (
            <p className="workspace-orchestration-connect__body">
              {t('orchestration.connect.busy')}
            </p>
          ) : null}
          {confirmation.errorCode ? (
            <p className="workspace-orchestration-connect__error" role="alert">
              {t(ERROR_KEYS[confirmation.errorCode] ?? 'orchestration.connect.error.generic')}
            </p>
          ) : null}
          <div className="workspace-orchestration-connect__actions">
            <Button
              variant="primary"
              size="sm"
              data-testid="orchestration-connect-accept"
              disabled={confirmation.inFlight}
              onClick={event => {
                event.stopPropagation()
                onAccept()
              }}
            >
              {t('orchestration.connect.accept')}
            </Button>
            <Button
              size="sm"
              data-testid="orchestration-connect-cancel"
              disabled={confirmation.inFlight}
              onClick={event => {
                event.stopPropagation()
                onCancel()
              }}
            >
              {t('orchestration.connect.cancel')}
            </Button>
          </div>
        </div>
      ) : null}
    </>
  )
}
