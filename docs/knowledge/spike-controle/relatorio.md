# Spike: Mesa de coordenação fora do núcleo

> **Status: estudo de uma ideia futura, parkeada em 2026-11-20. Não é um gate do plano ativo.**

Data: 2026-11-20. Perfil: `~/.config/opencove-dev` (nunca o principal). Worker final `0.4.0`, protocolo 2, pid 1015643, porta 38851.

## Veredito

**Sim, com lacunas, e uma delas bloqueia produção:** a Mesa cabe fora do núcleo para ler o portfólio, acompanhar execuções e despachar, mas aprovar e liberar hooks exige bearer admin (o token do desktop), e fila de trabalhos, custo/tokens e atenção itemizada não existem na interface pública.

## Necessidades da Mesa

| Necessidade | Operação pública | Estado | Evidência |
|---|---|---|---|
| Projetos | `project.list` | parcial | Ao vivo: 2 projetos com id, nome, path e space ativo. Não há saúde, branch, WIP nem última atividade. |
| Execuções por projeto | `orch.link.list` + `orch.status` | parcial | Ao vivo: 6 links, todos `closed`, 6/6 com `projectId`. `orch.status` devolve 0 links ativos. O status não traz `projectId`; o vínculo é por `executorNodeId`. `orch.link.list` não tem filtro de estado nem paginação. |
| Itens de atenção (id, tipo, idade, alvo) | `orch.status` + `/events?stream=agent` | parcial | Só contagens: `pendingApprovals`, `pendingHooks`, `notices.pending/uncertain`. Nenhuma operação lista `requestId`, `hookKey`, tipo, idade ou alvo. `agent.get` dá `blockedReason`, `blockedSummary` e `lastTransitionAt`, mas não o id do pedido; o stream de agente repete esse estado. |
| Fila de trabalhos prontos | nenhuma | ausente | 159 operações no catálogo público, nenhuma de fila (`queue`), portfólio (`portfolio`), atenção (`attention`) ou item de trabalho (`orch.work`). `orch.dispatch` envia texto para um link; o índice único `orchestration_dispatches_open_executor_unique_idx` permite um único dispatch aberto por executor. |
| Custo e tokens por execução | nenhuma | ausente | Nenhuma operação com `cost`, `token` ou `usage`. `ExecutorTurnUsage` existe na porta interna do executor, mas não é mapeado para `orch.status`; o runtime Codex grava `usage: null`. |
| Eventos em tempo real | `/events` e `/events?stream=agent` | parcial | SSE conecta em 3 ms. Em 5 s ociosos: 0 frames; nenhum evento de orquestração foi recebido ao vivo. Um `canvas.focus` provocado entregou `event: opencove.sync`, `id: 187`, tipo `canvas.focus`. O contrato tem `orchestration.links.updated`, mas não há evento de aprovação, hook, aviso ou dispatch. |
| Aprovar | `orch.approval.respond` | parcial | Ação pública e validada, escopo `admin`. Chamada com id falso devolveu `orch.not_linked`. O `requestId` não é exposto por nenhuma leitura pública; sem ele a ação é inutilizável fora do núcleo. |
| Aprovar hooks | `orch.hooks.approve` | parcial | Mesmo caso: escopo `admin`, `keys` não são listadas publicamente, id falso devolveu `orch.not_linked`. |
| Pausar e reexecutar | `orch.interrupt`, `orch.cancel`, `orch.dispatch` | parcial | `interrupt` interrompe o turno, não pausa/retoma. `cancel` exige `dispatchId` de `status.current`. Reexecutar exige reenviar o texto; não há transcript nem `finalExcerpt` público. |
| Despachar | `orch.dispatch`, `orch.spawn` | parcial | Só por link ativo, com `dispatchId`, `to` e texto. Não há item de trabalho, prioridade, dependência ou agente sugerido. Não provado ao vivo: nenhum link ativo no banco. |
| Saúde e WIP por projeto | `project.list` + `gitWorktree.statusSummary` | parcial | Branch e mudanças por path aprovado. Limite de WIP e saúde agregada não existem. |

## Provado ao vivo

- Worker subiu, `worker-control-surface.json` apareceu em 1 s; `whoami` devolveu `kind: bearer`, `scopeTier: admin`; `status` devolveu protocolo 2, app 0.4.0, `runtimeReady: true`.
- Probe: 23 chamadas, 17 ok e 6 falhas esperadas (`node.get` dos 6 executores deletados → `node.not_found`). Latência HTTP média 6 ms, p50 4 ms, máxima 39 ms na execução final. CLI completo (`node out/cli/opencove.mjs ... ping`) média 177 ms em 10 execuções, dominado pelo startup do Node.
- `project.list`: 2 projetos. `glimpse-teste` ativo, 1 space, 0 nodes; `bndes-garagem` sem space. `agent.list`: 0 agentes vivos.
- `orch.link.list`: 6 links, todos `closed`, `linksRevision: 32`, todos do projeto `3f251963…`; `health: starting` preso em links fechados. `orch.status {}` devolveu 0 links.
- `system.operations`: 159 operações; 12 de orquestração. O catálogo do CLI lista 169; `system.operations` omite 10 operações de desktop (`worker.*`, `pty.debugCrashHost`).
- `orch.approval.respond` e `orch.hooks.approve` com ids falsos: `orch.not_linked`, em 235 ms e 222 ms via CLI. Nenhuma mutação.
- SSE: 200 em 3 ms; 0 frames em 5 s, nenhum evento de orquestração; com `canvas.focus` manual, 1 frame `opencove.sync`/`canvas.focus`. `/events?stream=agent`: 200, só keepalive.

## Só provado pelo contrato ou pelo banco de teste

- SQLite do perfil: 6 links `closed`, 4 dispatches `completed` com `final_excerpt` de 70 a 95 caracteres, 4 notices `delivered` com payload de 389 a 414 bytes e 0 hook approvals. Nada disso é exposto por operação pública; `orch.status` só devolve estado, round e contagens.
- O texto dos 4 dispatches está nulo no SQLite após concluir; sobram `text_sha256` e `text_bytes`. Reexecutar não recupera o prompt original por nenhuma operação.
- `pendingApprovals` e `pendingHooks` vivem no slot em memória do executor; após restart do worker a contagem pode zerar. `notices` e `orchestration_hook_approvals` persistem em SQLite, mas só são lidos como contagem.
- `NoticeEntry` já tem `executorNodeId`, `kind`, `dispatchId`, `excerpt` e `createdAt`; `HookTrustPending` tem `key`, `event` e `origin`, mas não tem timestamp. A operação de atenção precisa montar o item e carimbar a idade do hook.
- `ExecutorTurnUsage` existe na porta `executorRuntime`, mas não aparece em `orchestrationDispatchViewSchema`.
- `SyncEventPayload` inclui `orchestration.links.updated`; não inclui atenção, aprovação, hook ou dispatch.
- `sessionGrantAllowsOperation` só libera `read` e `interact`; `approval.respond` e `hooks.approve` são `admin`, logo um grant de sessão não os chama.
- Build de 13/11 22:40 contra HEAD de 13/11 22:42; árvore `src/` limpa. O bundle contém `pendingApprovals: slot.pendingApprovals.size` e `pendingHooks`, então a forma do status bate com a fonte, mas não foi exercitada ao vivo.

## Lacunas e operações propostas

| Operação nova | Payload mínimo | Entrega |
|---|---|---|
| `orch.attention.list` | `{ projectId?, executorNodeId? }` | Itens com `{ id, kind: approval\|hook\|notice, executorNodeId, projectId, createdAt, target, summary }`. Para aprovação, `id` é o `requestId`; para hook, a `key`. Escopo `read` ou `interact`. |
| `orch.run.get` | `{ dispatchId }` ou `{ executorNodeId, dispatchId? }` | Estado do dispatch, round, timestamps, `finalExcerpt` e `usage: { inputTokens, outputTokens }`. Adicionar `usage` em `current`/`last` do status. |
| `orch.portfolio` | `{ projectIds?: string[] }` | Por projeto: execuções ativas, fila, atenção, última atividade, branch, health e WIP. Evita N+1 de `link.list` + `status` + `gitWorktree`. |
| `orch.queue.list` e `orch.work.*` | `{ projectId }` / `{ workId }` | Modelo novo de trabalho: `{ id, title, state, priority, dependencies, suggestedExecutorNodeId }`. Hoje não existe tabela de work item; `orchestration_dispatches.text` é o único conteúdo. |
| `orch.work.dispatch` | `{ workId, executorNodeId, dispatchId }` | Liga trabalho a execução sem reenviar texto solto. |
| `orch.attention.updated` (evento) | `{ executorNodeId, projectId, counts, itemIds }` | Fecha o tempo real sem polling do status. |
| Grant de orquestração | `{ tier: "orchestrator", ttlMs }` | Permitir aprovar/hooks sem entregar o bearer admin do desktop à Mesa. |

## Riscos

- **Token de desktop contra grant de sessão.** O único caminho para `orch.approval.respond` e `orch.hooks.approve` é bearer admin. Quem tem esse token controla o app inteiro; a Mesa fora do núcleo não deve recebê-lo.
- **Banco de teste vazio.** Havia só 6 links históricos fechados, executores deletados, 0 agentes e 0 nodes. O formato de atenção, o dispatch e as ações não foram exercitados ao vivo; `health: starting` em link fechado mostra dado velho.
- **Build de 13/11 contra fonte.** O bundle é 2 minutos anterior ao HEAD; a árvore `src/` está limpa e os campos do DTO aparecem no bundle, mas uma mudança não buildada ainda passaria despercebida.
- **Eventos ausentes.** Zero frames em 5 s ociosos. Só `orchestration.links.updated` existe no contrato; aprovação, hook e aviso não têm evento, então a Mesa precisaria de polling curto ou de uma operação nova.
- **Atenção em memória.** Aprovações e hooks pendentes ficam no slot do executor; restart do worker pode zerar as contagens.

## Próximo passo

1. Implementar `orch.attention.list` e `orch.run.get` como leitura, expondo `requestId`, `hookKey` e `usage`; sem modelo novo.
2. Definir grant de orquestração com escopo mínimo para aprovar/hooks, em vez de reutilizar o token do desktop.
3. Decidir a fila: se a Mesa precisa de trabalho com prioridade e dependência, criar o modelo `orch.work`; `orch.dispatch` sozinho não representa fila.
4. Repetir o probe num perfil descartável com 1 link ativo, 1 agente e 1 aprovação pendente; validar o formato real e a ação.
5. Adicionar `orchestration.attention.updated` ou incluir ids no status com polling de 2 a 5 s.

## Arquivos

- `docs/knowledge/spike-controle/probe.mjs`: probe sem dependências.
- `docs/knowledge/spike-controle/saida.json`: evidência redigida da execução.
- `docs/knowledge/spike-controle/README.md`: como subir, rodar e parar.
