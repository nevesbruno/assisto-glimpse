# Partição da fase 2: onda 5

Parte da [partição da fase 2](ORCHESTRATION_PHASE2_CARDS.md), que traz as regras de execução e a tabela de arquivos que mudam de dono. Este arquivo guarda o bloco de correções do teste manual de 11/11/2026, o card de segurança, o ajuste do F2-16 e o smoke Electron do fechamento. Os ids propostos entraram em [Riscos e testes](ORCHESTRATION_RISKS_AND_TESTS.md) pelo card H.

Estado final em 12/11/2026, branch `docs/orchestration-adr`. Todos os cards de código têm spec verde e revisão independente, com a exceção registrada do E-04 (revisão em curso no fechamento). As contagens deste arquivo vieram dos relatórios dos cards e de uma rodada local dos specs de integração citados.

## Decisões que valem na onda

| Decisão | Efeito |
| --- | --- |
| Q1, opção C | O reinício da TUI no `link.create` segue como hoje. A confirmação no canvas é card de fase seguinte (F3-02). O nó `exited` ao religar é bug desta onda (cards D1 e D2) |
| Q2 | O e2e real usa o `CODEX_HOME` padrão do Bruno só para executar. Agente não edita, copia nem apaga arquivo em `~/.codex` e não aprova hook de forma persistente |
| Q3 | Escopo de projeto de `node.delete` e `node.update` por grant entra agora (card SEC) |
| Espaço da ligação | A coluna `space_id` segue `NOT NULL` (sem migração, C-01 intacto) e a string vazia significa nó fora de space. O DTO deixa de exigir `min(1)` |

## Decisões que mudaram o plano (O1 a O24)

| Id | Decisão curta |
| --- | --- |
| O1 | O card E fica na alternativa barata: o código segue `orch.not_linked` e só a mensagem muda, dizendo que nenhum executor ligado casa com o seletor e apontando `orch link list`; sem `node.not_found` e sem snapshot novo |
| O2 | Q1 é gravada na linha do `orch.link.create` do ADR de despacho (linha 294), sem nova confirmação |
| O3 | `space_id` segue `NOT NULL`, string vazia significa fora de space, sem migração; o DTO é o único que recusa |
| O4 | O teste 2 do S1 sobe o app-server do Codex pessoal sem turno, com custo de modelo zero (Q2) |
| O5 | O SEC cobre também `node.get`, `node.list` e `canvas.focus` por grant, como segunda parte do card |
| O6 | O D1 pode acrescentar `retire(nodeId)` obrigatório em `ExecutorTuiLauncher` (`ports/hostPorts.ts`), com os fakes; nada mais muda na porta |
| O7 | O D1 corrige o sintoma 2 com `bindSession` gravando `running` e a reordenação do relaunch; se a corrida do renderer persistir, abre o D2 |
| O8 | Depois do close o nó mostra `exited`, não `failed`; rótulo próprio de ligação fechada fica para card de UI da fase seguinte |
| O9 | O SEC2 abre nesta onda para os demais caminhos de grant entre projetos (spawn primeiro, depois sessão, agent e space); o F2-16 passa a depender dele |
| O10 | O SEC2 nega por padrão, usa o projeto do grant como identidade implícita e roda em SEC2a e SEC2b sequenciais |
| O11 | O teste 2 do S1 não abre Claude com o perfil pessoal do Bruno; o orquestrador é Codex ou provedor de teste |
| O12 | SEC2a rodada 1 mais SEC2c (`pty.spawnInMount` por grant); o SEC2b é avisado da API opcional de `debugMessage` |
| O13 | O D2 volta o renderer ao HEAD e adia o kill do PTY antigo no main até o `sessionId` novo chegar ao renderer (timer de cerca de 3 s), coberto pelo guard existente |
| O14 | O SEC2b só vai a revisão depois de corrigir fixtures e paridade de `debugMessage`; agente novo; `space.create` entra no SEC2c |
| O15 | O autor do D2 também liga `tui.dispose()` no compose (`composeOrchestration.ts`), com teste pelo compose real |
| O16 | Rodada 1 do SEC2b por agente novo, mais o SEC2d (`attachAgentStateWatcher` e `detachAgentStateWatcher` escopados por grant) |
| O17 | O S1 rodada 1 espera o SEC2 fechar; sandbox forçado e prova do vermelho com zod reintroduzido em build temporário; sem `OPENCOVE_TEST_USE_REAL_AGENTS` |
| O18 | O F2-16 é partido em a (I-02, I-03, I-04, I-06), b (E-01, E-02, E-03, E-06, E-07) e c (E-08, E-04 e custo); a e b em paralelo |
| O19 | O H2 documenta agora o escopo por grant e a Q1 citando D1 e D2; o estado final deste arquivo espera o H3 e o F2-16 |
| O20 | O F2-16a é partido em a1 (I-02 e I-04) e a2 (I-03 e I-06), com teto de 90k de contexto por agente |
| O21 | O bloqueante dos dois avisos é recusado: o ADR (linhas 175 e 176) e o RC4 separam o aviso `uncertain` do envio e o `executor_down_in_turn`; a linha 49 de riscos é corrigida |
| O22 | O E-01 não usa override de executável, que derruba a cobertura de hook e vira `uncertain`; usa symlink do binário real no wrapper dir |
| O23 | O E-02 exige entrega do aviso depois do restart sem digitação; se ficar `pending`, é defeito de produto e o teste usa `it.fails` até a correção |
| O24 | A revisão do E-02 confirma o aviso preso (`unknown/degraded`, `hook_stale`, lote pending); caso de restart verde mais canário em `test.fail`, com card de prioridade alta na onda 6 |

## Cards

Mudanças de agrupamento: o B foi partido em B1 (backend) e B2 (frontend), com arquivos disjuntos e papéis diferentes. O D foi partido em D0 (diagnóstico sem edição) e D1 (correção), porque o ponto da correção não estava claro e podia exigir porta congelada. O D2 (corrida do renderer) e o SEC2 (escopo por grant nas demais operações) nasceram no meio da onda, decisões O9, O13 e O15.

| Card | Papel | Objetivo | Depende de | Estado e prova |
| --- | --- | --- | --- | --- |
| A | dev-backend | Boot espera o esquema pronto | Nada | Aprovado; `tests/integration/orchestration/compositionEmptyProfile.spec.ts` (I-09) |
| B1 | dev-backend | Ligação sem space aceita ponta a ponta | Nada | Aprovado; `tests/integration/orchestration/linkOutsideSpace.spec.ts` (I-10) |
| B2 | dev-frontend | Nó de agente desenha a aresta; parse falho deixa rastro | Nada | Aprovado; `tests/unit/terminalNode/terminalNodeFrame.agentHandles.spec.tsx`, `tests/unit/contexts/orchestration/orchestrationLinksStore.spec.ts`, `tests/unit/contexts/workspace/useTaskAgentEdges.links.spec.ts` |
| C | dev-frontend | Executor ligado não gera "Needs input" no fim de turno | Nada no código | Aprovado; `tests/unit/app/executorAttention.spec.ts` (U-13) |
| D0 | Explore (leitura) | Diagnóstico do ciclo da TUI do executor | Nada | Concluído; diagnóstico em `diagnostico-d0.md` (fora do repo), sem spec |
| D1 | dev-backend | TUI sai do modo serviço no close; relink não deixa `exited` | D0 e B1 | Aprovado; `tests/integration/orchestration/executorTuiCycle.spec.ts` e `executorTui.spec.ts` (I-05) |
| D2 | dev-backend | Corrida do renderer no relink e ordem exit/sync | D1 | Aprovado; `tests/unit/app/updateWorkspacesWithAgentExit.staleSession.spec.ts` e `tests/integration/orchestration/composeTuiDispose.spec.ts` |
| E | dev-backend | Seletor sem nó vira `orch.not_linked` com mensagem única | Nada | Aprovado; `tests/unit/app/orchestrationHandlers.spec.ts` e `tests/unit/app/cliOrch.spec.ts` |
| F | dev-backend | Sync bridge: causa do erro no log e heartbeat SSE | Nada | Aprovado; `tests/unit/app/workerSyncBridge.spec.ts`, `tests/unit/app/sseHeartbeat.spec.ts` e `tests/unit/app/agentRuntimeSse.heartbeat.spec.ts` |
| G | dev-backend | Pré-confiança de hook loga o motivo do `null` | Nada | Aprovado; `tests/unit/contexts/codexHookTrustResolver.log.spec.ts` |
| SEC | dev-backend | Escopo de projeto em `node.delete` e `node.update` por grant | Nada | Aprovado; `tests/unit/contexts/nodeControl.projectScope.spec.ts` e `tests/integration/orchestration/nodeProjectScope.spec.ts` (I-11) |
| SEC2a a SEC2d | dev-backend | Escopo por grant em spawn, sessão, agent, space e watchers | SEC | Aprovado; `tests/unit/app/grantProjectScope.spec.ts`, `mountAndSpace.grantScope.spec.ts`, `nodeCreate.grantScope.spec.ts`, `sessionPrepareOrRevive.grantScope.spec.ts`, `sessionGrantScope.spec.ts`, `agentListSessionsGrant.spec.ts`, `agentGrantPhantomParity.spec.ts` e `sessionAgentWatcherGrant.spec.ts` |
| S1 | test-automation | Smoke e2e Electron do fechamento | A, B1 e B2 | Aprovado; `tests/e2e/orchestration.smoke.spec.ts` (E-09), 2 passed |
| F2-16 | test-automation | Integração e e2e real com o Codex pessoal (Q2) | A, B1, B2, C, D1, E e SEC | a e b aprovados; c com E-08 aprovado e E-04 entregue, revisão em curso. Specs na seção "Arquivos novos de teste" |
| H | impl (documentos) | Q1, Q2 e ids novos nos documentos | Todos os de código | Fechado no H3b; H1, H2 e H3a entregues; `pnpm arch:doc-sync` verde |

## Ordem de execução

Teto de três agentes de código ao mesmo tempo. Comando pesado segue serializado pelo lock comum.

1. Onda 5.1: A, B1 e SEC em paralelo. O D0 roda junto, pois só lê.
2. Onda 5.2, depois de A, B1 e SEC aprovados: B2, C e E em paralelo.
3. Onda 5.3, depois de A, B1, B2 e D0 aprovados: D1 e S1 em paralelo. F e G entram aqui só se houver vaga (são independentes e podem rodar em qualquer onda com menos de 3 agentes).
4. Onda 5.4, depois de todos os cards de código aprovados: F2-16 e H em paralelo (arquivos disjuntos).
5. Fechamento do orquestrador: `pnpm verify:quick`, `pnpm arch:results`, S1 verde, e o Bruno abre o app antes do commit final.

Execução real: as ondas 5.1 a 5.4 mantiveram o teto de três agentes. O SEC2 abriu em 5.2 (O9) e o D2 em 5.3 (O13). O F2-16 rodou partido em a, b e c (O18), e o b em quatro blocos (O20).

## Resultado da onda

### Arquivos novos de teste

Caminhos relativos à raiz do repo. A contagem vem do relatório de cada card; as linhas de I-02 a I-06 foram reconferidas em rodada local em 12/11/2026.

| Id | Arquivo novo | Casos | Verde |
| --- | --- | --- | --- |
| E-01 | `tests/e2e/orchestration.real-codex.spec.ts` | 1 | 1 passed, 17 s (revisão 16,8 s) |
| E-02 | `tests/e2e/orchestration.real-codex.restart.spec.ts` | 2 (1 esperado) | 1 passed, 15,6 s; canário sem input em `test.fail`, 59,7 s |
| E-03 | `tests/e2e/orchestration.real-codex.service.spec.ts` | 3 (1 esperado) | 3 passed (1 esperado), 53,2 s na revisão |
| E-04 | `tests/e2e/orchestration.cost.real-model.spec.ts` | 1 pago | 1 passed, 20,2 s |
| E-06 | `tests/e2e/orchestration.hooks.real-codex.spec.ts` | 1 | 1 passed em 4 runs, 15 a 20,4 s |
| E-07 | `tests/e2e/orchestration.approval.real-codex.spec.ts` | 1 | 1 passed em 4 runs, 9,6 a 10,6 s |
| E-08 | `tests/e2e/orchestration.resend.real-codex.spec.ts` | 1 | 1 passed em r3 e r4, 46 a 49 s |
| I-02 | `tests/integration/orchestration/workerRestart.spec.ts` | 8 (1 esperado, 1 todo) | 6 passed, 1 expected fail, 1 todo |
| I-03 | `tests/integration/orchestration/serviceDeath.spec.ts` | 9 (2 esperados, 1 real) | 6 passed, 2 expected fail, 1 skipped sem a chave; 7 passed na variante real (estado) |
| I-04 | `tests/integration/orchestration/noticeOutbox.spec.ts` | 5 | 5 passed |
| I-05 | `tests/integration/orchestration/executorTui.spec.ts` | 8 | 8 passed |
| I-05 | `tests/integration/orchestration/executorTuiCycle.spec.ts` | 9 | 9 passed |
| I-06 | `tests/integration/orchestration/approvals.spec.ts` | 6 | 6 passed |
| S1 (E-09) | `tests/e2e/orchestration.smoke.spec.ts` | 2 | 2 passed |

`executorTui.spec.ts` já existia desde o F2-13 e foi estendido pelo D1; `executorTuiCycle.spec.ts` é novo. O E-05a (janela comum do opencode v2) pertence ao OC-01 e não a esta onda; o E-05b ficou para a fase 3 (F3-04). Os helpers e rigs novos que acompanham esses specs são `orchestration.real-codex.helpers.ts`, `orchestration.real-codex.claude.ts`, `orchestration.real-codex.restart.helpers.ts`, `orchestration.real-codex.service.helpers.ts`, `orchestration.hooks.real-codex.helpers.ts`, `orchestration.approval.real-codex.helpers.ts`, `orchestration.resend.real-codex.helpers.ts`, os quatro `orchestration.cost.real-model.*.ts`, `orchestration.smoke.helpers.ts`, `tests/integration/orchestration/phase2Rig.ts` e `codexServiceRig.ts`.

### E-04: custo com modelo real

Medição de 12/11/2026, uma execução paga autorizada em 09/11/2026, base `a73dffbd`, Codex 0.167.1 e modelo `gpt-6.1-terra` do perfil pessoal. Três despachos: `alpha` r1 com 25.758 tokens de cache write derivado, `alpha` r2 com 203 (1,15% do baseline de 17,6 mil e 99,38% de cache read) e `beta` r1 com 25.759. Os três avisos somam 679 caracteres (227, 225 e 227) em uma linha cada. Custo equivalente de API estimado em US$ 0,067080; sem cache, US$ 0,098899, e o teto com cobrança da escrita sobe para US$ 0,118800.

A leitura que importa é a segunda linha: o segundo despacho no mesmo executor não paga sessão nova. O primeiro turno de cada executor já lê 7.168 tokens de cache compartilhado, mas escreve cerca de 25,8 mil. O baseline de 17,6 mil vem de outra prova, com prompt e tokenizador diferentes, então a razão 1,46 não compara o mesmo prompt. O Codex reportou `cache_write_input_tokens = 0` nos três turnos e a coluna de escrita é derivada de `input - cache read`.

Detalhe completo, método, evidência e limitações em [`docs/research/orchestration-phase2-cost.md`](../research/orchestration-phase2-cost.md). O log do run real é `/tmp/opencode/glimpse-onda5/logs/f216c2/real-r1.log` (exit 0, 1 passed em 20,2 s) e o hash do perfil ficou igual antes e depois.

### Defeitos que viram card da onda 6

| Defeito | Evidência |
| --- | --- |
| Run state e aviso presos depois do crash | Depois do relaunch o orquestrador fica `unknown/degraded` com `hook_stale`, o lote fica `pending` até o usuário digitar; `orchestratorReadiness.ts:39-49`, `noticePump.ts:79-82`, `AgentRunStateRuntime.ts:350-356`. Canário do E-02 em `test.fail`: `expected delivered, received pending` em 49 s |
| Boot aborta com `orch.executor_unavailable` | Com despacho `sent` e crash, o passo de boot falha e o app-server não sobe; stderr `orchestration boot step failed` e `executor run state record without live session`; reproduzido no canário do E-02. O boot deve tolerar executor indisponível e continuar |
| Perda de aviso por colisão de dedupe | A quarta subida morta antes de `recovered` repete a chave `down:exec-alpha:2` (`supervisor.ts:123` usa só o contador de incidentes) e o quarto `executor_down` é descartado. Corrigir com contador monotônico ou `reason` na chave |
| Nome da thread com nodeId | `CodexExecutorRuntime.ts:382` grava `Glimpse: <nodeId>`, e R13 e o ADR pedem `Glimpse: título do nó`. Passar o título ao start spec |
| `orch close --to` só por id | O help diz "title or ID", mas o handler só resolve nodeId; o e2e monta título para id via `node list`. Resolver título no handler |
| Adoção de turno `running` no boot | O boot adota turno `running` sem sessão viva, o erro é engolido e o despacho fica `uncertain` sem aviso; coberto por `it.fails` em `workerRestart.spec.ts` (I-02) e registrado como card da onda 6 em `depois.md` |

### Fechamento

- `pnpm arch:doc-sync` verde.
- O arquivo tocado e o de riscos ficam abaixo de 500 linhas.
- O commit final depende do aval do Bruno e do app aberto; o script de commit da onda não roda sem isso.
- O F2-16c (E-04) tinha revisão independente em curso quando este arquivo fechou. Se a revisão reprovar, o estado do card muda.

## Arquivos que mudam de dono dentro da onda

| Arquivo | Sequência de donos |
| --- | --- |
| `src/app/main/controlSurface/orchestration/composeOrchestration.ts` | A, depois D1 (só fiação da TUI, se o D0 pedir) |
| `src/app/main/controlSurface/orchestration/composeOrchestrationDeps.ts` | B1, depois D1 (só se o D0 pedir) |
| `docs/architecture/CONTROL_SURFACE.md` e os três ADR | Só o H. Os outros cards reportam o texto que falta |

Os demais arquivos têm um dono só na onda. Arquivo de outro card é intocável.

## Arquivos no teto de linhas

| Arquivo | Linhas | Regra |
| --- | --- | --- |
| `src/app/main/controlSurface/controlSurfaceHttpRuntime.ts` | 500 | Nenhum card toca. O F só entra se extrair para `orchestration/` ou `remote/` |
| `.../infrastructure/codex/CodexExecutorRuntime.ts` | 499 | Nenhum card toca. Se o D1 precisar, extrai para módulo novo vizinho |
| `.../controlSurface/handlers/sessionHandlers.ts` | 442 | Alterado pelo SEC2b (extraiu `sessionGetKillHandlers.ts`), de 498 para 442 |
| `src/contexts/orchestration/application/OrchestrationService.ts` | 299 (teto 300) | Só o D1, trocando linha por linha. Lógica nova em módulo novo de `application/`, ao lado de `executorTuiRelaunch.ts` |
| `src/app/cli/commands/orch.ts` | 492 | Só o E, até 8 linhas líquidas. Mais que isso, extrair para `orchRender.ts` (novo, do E) |
| `composeOrchestrationDeps.ts` | 281 | B1 e D1 abaixo de 300. Acima, extrair `composeOrchestrationNodes.ts` (novo, do B1) |

Medir com `wc -l`, pois `scripts/check-max-lines.mjs` só lê arquivo staged.

## Card A: boot no perfil vazio

Papel dev-backend. No primeiro start com pasta nova, o boot não corre contra a criação do esquema (`no such table: agent_links`, `composeOrchestrationBoot.ts:20`).

- Arquivos donos: `src/app/main/controlSurface/orchestration/composeOrchestration.ts` (`lazyOrchestration.boot` espera `input.getPersistenceStore()` antes de `get()?.boot()`); `composeOrchestrationBoot.ts` (só se a espera for melhor como dependência `ready`); `tests/integration/orchestration/compositionEmptyProfile.spec.ts` (novo).
- Teste: I-09 proposto. Vermelho: pasta temporária sem banco, `PersistenceStore` real com criação do esquema atrasada, falha com `boot step failed` e `no such table`.
- Aceite: com pasta nova o boot termina sem `boot step failed` e `agent_links` existe quando a reconciliação roda; o `get()` por handler antes do boot também não toca a tabela cedo (o agente confirma se é alcançável); `compositionBoot.spec.ts` e `composition.spec.ts` verdes sem edição; `controlSurfaceHttpRuntime.ts` intocado.

## Card B1: ligação sem space (causa 1 da linha ausente)

Papel dev-backend. Link de nó fora de space chega ao espelho e ao renderer, em vez de falhar calado no `safeParse`.

- Arquivos donos: `src/shared/contracts/dto/orchestration.ts` (linha 65); `src/contexts/orchestration/domain/agentLink.ts` (só se houver validação de space; hoje só repassa); `composeOrchestrationDeps.ts` (`findNode`, linha 209, devolve `''` de propósito, com comentário); `src/platform/persistence/sqlite/read.ts` (linhas 105 e 268, rastro quando o parse do espelho falha); `tests/integration/orchestration/linkOutsideSpace.spec.ts` (novo); `tests/integration/orchestration/linksMirror.spec.ts`; `tests/integration/orchestration/persistence/appStateMirror.spec.ts`.
- Teste: I-10 proposto. Vermelho: dois nós de agente sem space, ligados, e `readAppStateFromDb` não devolve `orchestrationLinks` por causa do `min(1)`.
- Aceite: ida e volta do espelho com `spaceId` vazio sem perda; `link.create` entre nós fora de space devolve `{ linkId, runtimeMode }`; parse que falha deixa log com o motivo e não derruba a leitura; `orch link list` e `orch status` não quebram com `spaceId` vazio (leitura de `orch.ts`, sem editar).
- Fora de escopo, item "depois": `createExecutorNode` (linha 226) ainda exige space no orquestrador do modo `spawn`.

## Card B2: aresta da linha e rastro no renderer (causa 2)

Papel dev-frontend. O nó de agente ganha `Handle` source e o `readOnce` deixa rastro quando o parse falha.

- Arquivos donos: `src/contexts/workspace/presentation/renderer/components/terminalNode/TerminalNodeFrame.tsx` (linhas 133 e 134 e o bloco de `Handle` da linha 213; 343 linhas); `src/contexts/orchestration/presentation/renderer/orchestrationLinksStore.ts` (`readOnce`, linhas 41 a 57); `src/contexts/workspace/presentation/renderer/components/workspaceCanvas/hooks/useTaskAgentEdges.ts` (só se o `sourceHandle` exigir id); `tests/unit/terminalNode/terminalNodeFrame.agentHandles.spec.tsx` (novo); `tests/unit/contexts/orchestration/orchestrationLinksStore.spec.ts`; `tests/unit/contexts/workspace/useTaskAgentEdges.links.spec.ts`.
- Vermelho: o spec novo falha porque o nó `agent` renderiza só `Handle` target.
- Aceite: nó `agent` com `Handle` target e source e nó `task` igual ao atual; `useTaskAgentEdges` produz a aresta para link ativo com `spaceId` vazio; `readOnce` com espelho inválido registra o motivo sem lançar; specs `terminalNodeFrame.*` existentes verdes sem edição. A aresta no DOM de ponta a ponta fica com o S1.

## Card C: alerta "Needs input" do executor ligado

Papel dev-frontend. Só aprovação do executor chega ao usuário, o fim de turno não.

- Arquivos donos: `src/app/renderer/shell/hooks/useAgentStandbyNotificationWatcher.ts` (264 linhas; filtro antes da linha 224, ao lado do `readExecutorHealth` da linha 190); `src/app/renderer/shell/utils/sidebarAgents.ts` (`resolveSidebarAgentStatus`, só se ainda mostrar "waiting" pelo status cru); `tests/unit/app/executorAttention.spec.ts`.
- Teste: U-13 proposto. Vermelho: fim de turno de nó presente em `readExecutorHealth` ainda chama `standbyHandlerRef`.
- Aceite: executor ligado no fim de turno não alerta e nó comum continua alertando; a aprovação pendente (ramo da linha 190) segue alertando; o agente registra se `resolveSidebarAgentStatus` mudou e por quê. O teste usa o store com link válido, pois o store vazio esconde o filtro em uso real.

## Cards D0 e D1: ciclo da TUI do executor

D0 é um Explore somente leitura, sem arquivo próprio. Ele entrega o ponto exato da correção de dois sintomas: o Codex preso em "Reconnecting to server" depois do `orch close` (o que `closeExecutorLink` em `linkLifecycle.ts` faz com o PTY da TUI), e o nó `exited` logo depois de religar (link 1d8aa663; o que `attachTui(..., 'relaunch')` de `linkCreate.ts:52` faz com a TUI antiga e onde `executorTuiLauncher.ts:45` falha). Diz também se a correção exige mudar porta congelada (`ports/hostPorts.ts`), decisão do orquestrador.

D1, papel dev-backend, depende de D0 e B1.

- Arquivos donos (candidatos, fixados pelo D0): `src/app/main/controlSurface/orchestration/executorTuiLauncher.ts`; `src/contexts/orchestration/application/executorTuiRelaunch.ts`, `linkCreate.ts`, `linkLifecycle.ts` (267 linhas) e `spawnExecutor.ts`; `composeOrchestration.ts` e `composeOrchestrationDeps.ts` (herdados, só fiação); `tests/integration/orchestration/executorTui.spec.ts`; `tests/integration/orchestration/executorTuiCycle.spec.ts` (novo).
- Vermelho: definido pelo D0. Sem D0 aprovado o D1 não começa.
- Aceite: depois do `orch close` a TUI não fica em reconexão (o PTY termina ou vira sessão comum, conforme o D0) e o nó mostra o novo estado; religar o mesmo nó, com TUI aberta ou depois de close, termina com nó vivo e `runtimeMode` `service`, nunca `exited`; `OrchestrationService.ts` até 300 linhas; `ports/hostPorts.ts` só com autorização no briefing.

## Card E: seletor `--to` que não casa

Papel dev-backend. `orch dispatch --to codex` diz que nenhum executor ligado casa com o seletor e aponta `orch link list`.

- Arquivos donos: `src/app/main/controlSurface/handlers/orchestrationHandlers.ts` e `orchestrationHandlers.support.ts` (o embrulho já conhece `input.to` e `providerOfNode`); `src/app/cli/commands/orch.ts` (até 8 linhas) e `tests/unit/app/cliOrch.spec.ts`; `tests/unit/app/orchestrationHandlers.spec.ts`. Sem `domains/orch.ts` e sem snapshot novo (O1).
- Vermelho: o handler devolve `orch.not_linked` sem a mensagem única para `to` sem nó correspondente.
- Aceite (O1, alternativa barata): `to` sem nó devolve `orch.not_linked` com a mensagem única `NOT_LINKED_MESSAGE`, que aponta `orch link list`; nó de outro projeto e nó sem ligação seguem indistinguíveis (A4, U-09); a CLI mostra a mensagem do erro; `operationRegistry.spec.ts` e `controlSurface.introspection.spec.ts` verdes sem snapshot novo.

## Cards F e G: opcionais da triagem

Caminhos conferidos só pelo briefing do coordenador, marcados "a confirmar pelo agente do card". Disjuntos de A a E e do SEC.

- F, dev-backend: `src/app/main/controlSurface/remote/workerSyncBridge.ts` (linha 190, logar `error.cause?.code`); heartbeat SSE `:\n\n` a cada 15 a 30 s nos clientes de sync, em `controlSurfaceHttpRequestHandler.ts` (linhas 164 a 260) ou onde vivem os `syncClients`; spec novo `tests/unit/app/workerSyncBridge.spec.ts` (a confirmar). `controlSurfaceHttpRuntime.ts` (500 linhas) só com extração, e o card é dono dele só nesse caso.
- G, dev-backend: `src/contexts/agent/infrastructure/providers/codex/CodexHookTrustResolver.ts` (linhas 22 a 24, logar o motivo do `null`: timeout, contagem divergente, hook desabilitado); spec do resolvedor (a confirmar).
- Aceite de ambos: o log traz a causa; sem mudança de comportamento; testes do próprio escopo verdes.

## Card SEC: escopo de projeto por grant (Q3)

Papel dev-backend, com revisão focada em segurança. `node.delete` e `node.update` por grant só alcançam nó do projeto do grant, e nó de outro projeto é indistinguível de inexistente.

- Arquivos donos: `src/app/main/controlSurface/handlers/nodeControlHandlers.ts` (linhas 136 a 167: derivar o projeto de `ctx.requestAuth` quando `kind` é `session-grant`); `src/contexts/workspace/application/nodeControl/nodeControlDelete.ts` e `nodeControlUpdate.ts` (opção `projectScope`, `node.not_found` quando `matched.workspace.id` difere); `tests/unit/contexts/nodeControl.projectScope.spec.ts` (novo); `tests/integration/orchestration/nodeProjectScope.spec.ts` (novo).
- Teste: I-11 proposto; I-07 segue verde. Vermelho: o grant apaga e atualiza nó de outro projeto e, com ligação ativa, a exclusão fecha a ligação dele (5b).
- Aceite: grant atua no próprio projeto e recebe `node.not_found` com o mesmo corpo para nó de outro projeto e para id inexistente; nó de outro projeto não muda nem fecha ligação ou serviço (afirmado com a ligação do projeto B ativa); usuário, bearer e o canal do `pluginCanvasHost.ts` seguem sem escopo; a revisão cobre o grant HTTP de ponta a ponta.
- `node.get`, `node.list` e `canvas.focus` entraram na segunda parte do card SEC (O5) e também ficam restritos ao projeto do grant.

## Card S1: smoke e2e Electron do fechamento

Papel test-automation, dono do smoke (não é o F2-16). Depende de A, B1 e B2. Roda em paralelo com o D1.

- Arquivos donos: `tests/e2e/orchestration.smoke.spec.ts` e `tests/e2e/orchestration.smoke.helpers.ts` (novos). Parte de `tests/e2e/app-shell.preload-sandbox.spec.ts` e dos helpers de `agent.prompt.real-codex.helpers.ts`, só por importação.
- Teste: E-09 proposto.
- Aceite: teste 1, sempre ligado e sem Codex: a janela abre, `window.opencoveApi` existe e o log do preload não traz `require("zod")` nem erro de módulo. Teste 2, com `OPENCOVE_TEST_REAL_CODEX=1`: dois nós de agente fora de space, `link.create` pela CLI, aresta no DOM do canvas. O `link.create` só sobe o app-server do Codex pessoal e não dispara turno, então o custo de modelo é zero. Falha vira relatório com causa.

## F2-16: ajuste pela Q2

O card existente (`ORCHESTRATION_PHASE2_CARDS.md`, seção "Onda 5") mantém objetivo, papel e arquivos donos, e o H grava os ajustes lá. Depende de A, B1, B2, C, D1, E e SEC. Roda em paralelo com o H.

| Ajuste | Texto |
| --- | --- |
| Perfil | Os e2e reais usam o `CODEX_HOME` padrão do Bruno. Os helpers deixam de criar pasta temporária e herdam o ambiente |
| Proibido | Escrever, copiar ou apagar em `~/.codex`. O teste só lê o hash de `config.toml` e `hooks.json` antes e depois (E-01 e E-06) e exige hash igual |
| Hooks | O E-06 aprova hook só por `-c` no processo lançado, nunca persistente, e tolera o pedido de revisão de hooks do perfil pessoal |
| Histórico | Threads "Glimpse: título do nó" saem da lista padrão no close (R13). O teste não apaga arquivo de sessão. O nome ainda grava o nodeId; o título é card da onda 6 |
| Custo | E-04 segue com uma execução única, autorizada em 09/11/2026, com consumo no plano dele |
| Smoke | O dono é o S1. O F2-16 não edita os dois arquivos de smoke |
| Falha | O F2-16 reporta com causa e não corrige código sob teste. Defeito achado vira card novo |

## Card H: documentos

Papel impl. Depende de todos os cards de código aprovados.

- Arquivos donos: `docs/architecture/ADR-orchestration-dispatch-and-surface.md`; `docs/architecture/CONTROL_SURFACE.md`; `docs/architecture/ORCHESTRATION_PHASE2_CARDS.md` (ajuste do F2-16 e ponteiro para este arquivo); `docs/architecture/ORCHESTRATION_RISKS_AND_TESTS.md` (linhas 96 e 100, sem `CODEX_HOME` isolado nos e2e reais, e os ids novos); este arquivo (estado final).
- Aceite: Q1 (opção C, confirmação no canvas em fase seguinte, reinício atual segue) registrada no ADR e no `CONTROL_SURFACE.md`; `CONTROL_SURFACE.md` registra o `orch.not_linked` do seletor sem nó (E) e o escopo de projeto por grant (SEC); ids U-13, I-09, I-10, I-11 e E-09 viram linhas no documento de riscos; sincronia de documentos do harness passa e nenhum arquivo passa de 500 linhas.
- O ADR não traz item rotulado "E5". O H registrou a Q1 junto da linha do `orch.link.create` (linha 294), conforme O2, sem nova confirmação.
- H1, H2 e H3a entregues. O H3a corrigiu as linhas 49 e 96 de riscos e a frase falsa do card SEC; o H3b fechou este arquivo com o resultado do F2-16.

## Opcionais de fase seguinte

| Item | Destino | Motivo |
| --- | --- | --- |
| Títulos "default model" nos dois nós | Card curto de frontend, fase seguinte | O ponto que grava o título não está localizado (`toAgentNodeTitle`, `format.ts:78`, é só um candidato) |
| Aviso ao orquestrador de que ganhou executor | F3-02, junto da confirmação no canvas | Toca `OrchestrationService.ts` (299 linhas), `linkCreate.ts` e o compositor de avisos, em uso pelo D1 |
| Claude com estado desconhecido | Onda 6 | Decisão do coordenador, sem partição aqui |
