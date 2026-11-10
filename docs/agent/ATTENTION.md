# Agent attention

When an Agent ends a turn and waits for you, OpenCove tells you once. Three channels can carry it.
Each has its own switch in Settings › Notifications and a tile in the Control Center:

- **In-app card**: a pixel card that grows out of the agent pill ([Agent Island](../ui/AGENT_ISLAND.md)).
  Clicking it focuses the Agent. After six seconds it retracts into the pill, where the Agent keeps
  waiting until you answer it.
- **System notification**: the operating system's banner, sent only while OpenCove is not in front.
- **Sound**: one synthesised alert (`bit` pixel default, `tide`, `pebble`), at its own volume.

## Routing

| OpenCove is | In-app card | System notification         | Sound            |
| ----------- | ----------- | --------------------------- | ---------------- |
| In front    | shown if on | dropped by main, even if on | plays once if on |
| Behind      | shown if on | sent if on, always silent   | plays once if on |

- The app plays the one sound itself, in front or behind; the system notification never sounds, so
  an alert never chimes twice.
- Clicking a system notification focuses that Agent through the same jump as clicking its card.

## Unanswered Agents

An Agent whose card was shown and not yet answered **needs you**, though its runtime status is only
standby. Everywhere the shell counts or labels Agents waiting for you, it is one of them, waiting
since its card arrived: the pill and its list, the sidebar inbox, project tile badges, Agent rows
and each Space's count and mini map. One rule decides it (`resolveNeedsYouSinceMs`); window
signals on the canvas keep following the runtime status.

- The pending list is `useAgentAttentionStore`: transient, never persisted, newest first, at most 20.
  The router adds to it (`show-card`) and takes an Agent out when it works again (`clear-card`).
- You answer an Agent by closing its card (✕) or by going to it from anywhere: card, list, sidebar,
  command center or system notification. All of these call `handleSelectAgentNode`, which
  acknowledges the Agent before it focuses it.
- A card that retracts, by its countdown or because the list opened, answers nothing.
- With in-app cards switched off nothing is pending, so a standby Agent is not counted.
- Only standby counts: an Agent that works, is blocked on a prompt, exits or fails keeps the
  status it shows without the card, even while its card is still pending.

## Owners

| Decision                      | Owner                                                           |
| ----------------------------- | --------------------------------------------------------------- |
| Did an Agent start waiting?   | `useAgentStandbyNotificationWatcher` (renderer, from PTY state) |
| Which channels fire, and when | `createAgentAttentionRouter` (`agentAttentionRouter.ts`)        |
| Which Agents are unanswered   | `useAgentAttentionStore` (renderer, transient)                  |
| Is OpenCove in front?         | Main (`systemNotifications.ts`): any focused app window         |
| What the sound is             | `notificationSound.ts`: Web Audio, no files                     |

The renderer cannot trust its own focus signals for the foreground gate, so main decides it at the
moment it would show the notification.

## Linked executors

An executor linked to an orchestrator (an active `executor` link in `orchestrationLinksStore`)
calls you in two more cases, through the same router and the same three channels. A common Agent
waiting on a permission still raises nothing.

- **Stopped on a request.** Run state `waiting` with `blockedReason: 'permission'`. The card and
  the system notification carry the executor name and `blockedSummary`, read only together with
  `state === 'waiting'` (the ingress can clear the reason without clearing the summary).
- **Unavailable.** The link health turns `unavailable` (no run state says it). The first read of
  the link mirror is a baseline.
- The alert is a `show-card` item with `alert: { reason, summary }`. Its "needs you" entry is keyed
  by `executorAttentionKey`, so `resolveNeedsYouSinceMs` keeps it whatever the status shows, in the
  sidebar and the Space, until the pendency ends (the executor leaves the wait or recovers).
- Clicking the notification or the card goes to the executor node.
- **Repeat.** Off by default (`executorAlertRepeatEnabled`). On, every `executorAlertRepeatMinutes`
  (1 to 60) the sound and a replacing notification fire again while the pendency lasts; the card is
  not shown again. Switches and interval are read at each step.

## Invariants

- **One alert per wait.** An Agent already announced is not announced again until it has worked for
  at least 800 ms (`AGENT_ATTENTION_REWORK_DEBOUNCE_MS`). Shorter work is jitter: the card stays and
  nothing sounds.
- **One sound per burst.** Agents that start waiting within 1.5 s (`AGENT_ATTENTION_COALESCE_MS`)
  share one sound and one system notification. The first notification names its Agent; when the
  window closes with more than one Agent still waiting, it is replaced by one that counts them
  ("3 Agents need you"). Cards stay one per Agent.
- **No alert at startup.** A wait whose `observedAtMs` predates the watcher, or an Agent still being
  restored, is a baseline, not news.
- **Switches are read when the alert fires**, not when the router was created.

## Tests

- Decision table, coalescing, debounce: `agentAttentionRouter.spec.ts`.
- Unanswered Agents: `useAgentAttentionStore.spec.ts`, `agentActivitySummary.spec.ts`.
- Executor alerts (U-11): `tests/unit/app/executorAttention.spec.ts`.
- Startup baseline: `tests/unit/app/agentStandbyTerminalNotification.spec.ts`.
- Foreground gate, silent delivery, replacement and click: `tests/contract/ipc/systemNotificationIpc.spec.ts`.
- End to end, in front and behind: `tests/e2e/workspace-canvas.agent-attention-routing.spec.ts`.
  Main records notifications in `globalThis.__opencoveSystemNotificationTestState` (a test can
  pretend focus and click one); the renderer records sounds in `window.__opencoveNotificationSoundTestLog`
  instead of playing them.
