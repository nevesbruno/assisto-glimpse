# Partição da fase 2: onda 4

Parte da [partição da fase 2](ORCHESTRATION_PHASE2_CARDS.md), que traz as regras de execução, as outras ondas e a tabela de arquivos que mudam de dono. Este arquivo guarda o F2-14 em etapas. Os testes citados por id (U, C, I, E) estão em [Riscos e testes](ORCHESTRATION_RISKS_AND_TESTS.md).

## Onda 4

Ordem de execução:

1. Em paralelo: etapa 1 e etapa 2 (arquivos disjuntos).
2. Depois da etapa 2 aprovada: etapa 3 e etapa 2b em paralelo (arquivos disjuntos). A etapa 1 pode rodar junto delas.
3. Depois das etapas 1, 2, 2b e 3 aprovadas: etapa 4r, sequencial antes da 4a.
4. Depois da 4r aprovada: etapa 4a e etapa 4s em paralelo (arquivos disjuntos).
5. Depois da 4a aprovada: 4b1 e 4c em paralelo (arquivos disjuntos).
6. Depois da 4b1 e da 4c aprovadas: 4b2 e etapa 5 em paralelo (arquivos disjuntos).
7. Depois da 4b2 aprovada: 5b. Depois da 4b2, da 5 e da 5b aprovadas: 4d.
8. A etapa de documentos corre em paralelo com a 4d.

### F2-14 Handlers e composição no Worker

Card da onda 4. O card é maior que o F2-08, que parou em 152k de contexto, então roda em etapas (1, 2, 2b, 3, 4r, 4s, 4a, 4b1, 4b2, 4c, 4d, 5 e 5b), cada uma com teto de 110k para o agente `dev-backend`. As decisões de porta estão no ADR de despacho e superfície e no registro do arquiteto de 10/11/2026.

| Campo | Valor |
| --- | --- |
| Objetivo | Expor `orch.*` no Control Surface no lugar do handler provisório, compor o contexto no Worker, aplicar a matriz de autorização e fechar o atalho do `agent.prompt` |
| Papel | dev-backend |
| Depende de | F2-02c, F2-05, F2-07, F2-08, F2-08b, F2-09, F2-09b, F2-10, F2-11, F2-12 e F2-13 |

| Etapa | Nome | Arquivos donos | Paralela com | Depende de |
| --- | --- | --- | --- | --- |
| 1 | Espelho de ligações e persistência | `src/platform/persistence/sqlite/read.ts`, `write.ts`, `normalize.ts` e `schema.ts` (só a chave `orchestration_links_mirror` em `DbAppMetaKey`); `src/app/main/controlSurface/orchestration/orchestrationLinksMirror.ts` (novo); `tests/integration/orchestration/persistence/appStateMirror.spec.ts` (novo); `tests/integration/orchestration/linksMirror.spec.ts` (novo) | 2 e 3 | Nada |
| 2 | Pontos de extensão do serviço | `application/OrchestrationService.ts` (máx. 290 linhas); `application/linkCreate.ts` (novo); `application/executorTuiRelaunch.ts` (novo); `application/reconcileOnBoot.ts`; `application/linkLifecycle.ts` (só o fim de turno de `executor_down`); specs novos `linkCreate.spec.ts`, `executorTuiRelaunch.spec.ts`, `orchestrationService.health.spec.ts` e os specs de aplicação tocados | 1 | Nada |
| 3 | Handlers e contrato | `src/app/main/controlSurface/handlers/orchestrationHandlers.ts` e `orchestrationHandlers.support.ts` (novos); `orchestrationProvisionalHandlers.ts` (removido); `registerControlSurfaceHandlers.ts`; `src/shared/contracts/controlSurface/operations/registry.ts`; `operations/domains/orch.ts`; `src/shared/contracts/dto/orchestration.ts` e `dto/index.ts`; `docs/architecture/CONTROL_SURFACE.md`; `tests/unit/app/orchestrationHandlers.spec.ts` (novo); snapshots de introspecção e de CLI que mudarem | 1 e 2b | 2 |
| 2b | Identidade do serviço | `application/ports/executorRuntime.ts` (tipo `ExecutorServiceIdentity` e método `serviceIdentity`); `infrastructure/codex/CodexAppServerProcess.ts` (campo `tokenSha256`); `infrastructure/codex/CodexExecutorRuntime.ts` (método `serviceIdentity`; se passar de 290 linhas, extrair para `codexServiceIdentity.ts`); `infrastructure/codex/CodexOrphanReaper.ts` (guarda `pid <= 1`); `application/serviceIdentity.ts` (novo); `application/spawnExecutor.ts`; `application/reconcileOnBoot.ts` (herdado da etapa 2); `tests/unit/contexts/orchestration/application/fakes.ts`; `tests/unit/contexts/orchestration/codex/CodexExecutorRuntime.spec.ts`; `tests/unit/contexts/orchestration/application/serviceIdentity.spec.ts` (novo); `tests/unit/contexts/orchestration/codex/CodexOrphanReaper.spec.ts` | 1 e 3 | 2 |
| 4a | Montagem | `src/app/main/controlSurface/orchestration/composeOrchestration.ts` e `composeOrchestrationDeps.ts` (novos, até 300 linhas cada); `controlSurfaceHttpRuntime.ts` (no máximo 6 linhas a mais); `registerControlSurfaceHandlers.ts` (só a passagem de `orchestration`, herdado da etapa 3); `tests/integration/orchestration/composition.spec.ts` (novo) | 4s | 1, 2, 2b, 3 e 4r |
| 4r | Adaptador do run state | `src/app/main/controlSurface/orchestration/executorRunStateAdapter.ts` (novo, até 300 linhas); `tests/unit/app/executorRunStateAdapter.spec.ts` (novo) | Nenhuma | 1, 2, 2b e 3 |
| 4s | Porta do run state | `application/ports/hostPorts.ts`; `application/approvals.ts`; `application/reconcileOnBoot.ts` (herdado da 2b); `executorRunStateAdapter.ts` (herdado da 4r); `tests/unit/contexts/orchestration/application/fakes.ts`, `approvals.spec.ts` e `reconcileOnBoot.spec.ts`; `tests/unit/app/executorRunStateAdapter.spec.ts` | 4a | 4r |
| 4b1 | Eventos | `composeOrchestration.ts` e `composeOrchestrationDeps.ts` (herdados da 4a); `composeOrchestrationEvents.ts` (novo); `controlSurfaceHttpRuntime.ts` (no máximo 4 linhas líquidas, só passagem de dependência); `tests/integration/orchestration/compositionEvents.spec.ts` (novo) | 4c | 4a |
| 4b2 | Boot e descarte | `composeOrchestration.ts`; `composeOrchestrationBoot.ts` (novo); `controlSurfaceHttpRuntime.ts` (no máximo 4 linhas líquidas); `application/OrchestrationService.ts` (método `shutdown`, até 300 linhas); `application/serviceShutdown.ts` (novo); `tests/unit/contexts/orchestration/application/serviceShutdown.spec.ts` (novo); `tests/integration/orchestration/compositionBoot.spec.ts` (novo) | 5 | 4b1 |
| 4c | Revive | `registerControlSurfaceHandlers.ts` (herdado da 4a, só a passagem do revive); `handlers/sessionHandlers.ts` (no máximo 4 linhas líquidas) e `handlers/sessionPrepareOrReviveHandler.ts`; `handlers/sessionPrepareOrRevivePreparation.ts` (só reexporta), `sessionPrepareOrReviveTerminalPreparation.ts` e `sessionPrepareOrReviveTerminalAgent.ts`; `tests/unit/app/sessionPrepareOrReviveExecutor.spec.ts` (novo); `tests/integration/orchestration/executorTui.spec.ts` (só remove o bloco `reviving an executor node`) | 4b1 | 4a |
| 5 | Autorização e CLI | `handlers/agentPromptHandlers.ts`, `sessionInputHandlers.ts` e `directInputGuard.ts` (novo); `handlers/orchestrationHandlers*.ts`; `src/app/cli/commands/orch.ts` e `tests/unit/app/cliOrch.spec.ts` (só `render.fields`); `tests/integration/orchestration/authorization.spec.ts` (novo) | 4b2 | 4b1 e 4c |
| 5b | Exclusão de nó | `application/OrchestrationService.ts` (até 300 linhas); módulo novo de aplicação sobre `closeExecutorLink(..., 'node_deleted')` de `linkLifecycle.ts`; `composeOrchestration*.ts` (ligação a `onStatePersisted` e ao boot); `tests/integration/orchestration/nodeDeletion.spec.ts` (novo) | Nenhuma | 4b2 |
| 4d | Entrega única de prompt | `registerAgentPromptHandlers` e `composeOrchestration*.ts` (instância única de `PromptDeliveryService`); spec de composição do prompt | Documentos | 4b2, 5 e 5b |

Arquivos de dono anterior: `read.ts`, `write.ts`, `normalize.ts`, `PersistenceStore.ts` e `sessionPrepareOrReviveTerminalPreparation.ts` têm só commits fora da orquestração (`git log --oneline`, 10/11/2026). `schema.ts` e `OrchestrationService.ts` vêm das ondas 1 e 3, sem coexistir.

- `registry.ts` muda de dono da etapa 3 para a etapa 4a.
- `registerControlSurfaceHandlers.ts` passa da etapa 3 para a 4a (só a passagem de `orchestration`) e depois para a 4c (só a passagem do revive), nunca juntas.
- `composeOrchestration*.ts` passa da 4a para a 4b1, depois para a 4b2, a 5b e a 4d, sempre em sequência.
- `OrchestrationService.ts` passa da etapa 2 (290 linhas) para a 4b2 e a 5b (até 300 linhas).
- `reconcileOnBoot.ts` passa da etapa 2 para a 2b e a 4s, e `executorRunStateAdapter.ts` da 4r para a 4s.

#### Etapa 1: espelho de ligações e persistência

Objetivo: gravar e ler o espelho de ligações no estado sincronizado, e publicar `orchestration.links.updated` uma vez por mudança.

| Item | Valor |
| --- | --- |
| Aceite que fecha | `writeNormalizedAppState` grava `orchestrationLinks` e `readAppStateFromDb` o devolve, ida e volta sem perda; `readAppState` devolve o espelho do Worker e a seta aparece de ponta a ponta; o Worker grava o espelho a cada mudança de ligação e na reconciliação, e escrita forjada via `sync.writeState` não muda `orch.dispatch` e some na próxima reconciliação; `linksMirror.spec.ts` |
| Testes | I-01 (parte do espelho forjado, no `linksMirror.spec.ts`); spec novo de ida e volta |
| Vermelho esperado | `appStateMirror.spec.ts` falha porque `readAppStateFromDb` não devolve `orchestrationLinks`; `linksMirror.spec.ts` falha por módulo ausente |
| Regra | O espelho vai em `app_meta`, chave `orchestration_links_mirror`, em JSON validado por `orchestrationLinksMirrorSchema` ao ler. A gravação do espelho não reescreve workspaces nem avança `app_state_revision`: é uma função própria em `write.ts`, `writeOrchestrationLinksMirror(db, mirror)`. `normalize.ts` só carrega o campo opcional |
| Aviso | O `health` do espelho entra por função injetada (`healthOf`), sem importar o serviço |

#### Etapa 2: pontos de extensão do serviço

Objetivo: dar ao serviço o que a composição e os handlers precisam, sem mudar o fluxo do despacho.

| Item | Valor |
| --- | --- |
| Aceite que habilita | `orch.link.create` (caso de uso `createLink`); evento em `unavailable` e na volta (`subscribeHealth`); relançar a TUI no boot (`relaunchExecutorTui`) |
| Pendências que fecha | Turno achado em curso na reconciliação chama `recordTurnStarted`; despacho que falha com `executor_down` chega ao run state como fim de turno |
| Testes | `linkCreate.spec.ts` (nó inexistente, mesmo nó, projeto cruzado, executor já ligado, falha de serviço fecha a ligação com `spawn_failed`, resultado `{ linkId, runtimeMode }`); `executorTuiRelaunch.spec.ts` (serviço de pé, serviço caído reinicia antes, sem ligação devolve `false`); `orchestrationService.health.spec.ts` (ouvinte recebe só mudança de saúde, cancelador funciona) |
| Vermelho esperado | Os três specs falham por módulo ou método ausente |
| Limite | `OrchestrationService.ts` sobe de 261 para no máximo 290 linhas, só com delegadores de uma linha; a lógica fica nos arquivos novos (cada um com menos de 120 linhas) |

#### Etapa 3: handlers e contrato

Objetivo: trocar o handler provisório pelos doze handlers reais, ainda sem serviço composto (o serviço entra por dependência).

| Item | Valor |
| --- | --- |
| Aceite que fecha | Handler provisório sai e as doze `orch.*` são registradas; `operationRegistry.spec.ts` e `controlSurface.introspection.spec.ts` verdes; `orch.dispatch` mapeia `orch.dispatch_in_flight` com `details`; `DispatchRuleError` vira `orch.*` ou erro interno; `principal.provider` do estado do app; `fresh: true` recusado com `common.invalid_input` e "fresh indisponível na fase 2"; `errors` declarados e snapshots atualizados; `orchestrationHooksApproveResultSchema`; handlers de `orch.link.create` e `orch.link.list` |
| Pendências que fecha | Remover o registro provisório; mapear `DispatchRefusedError` para `details` |
| Testes | `orchestrationHandlers.spec.ts` com serviço falso (uma linha por erro e por operação); I-01 não entra aqui |
| Vermelho esperado | O spec falha porque `orchestrationHandlers.ts` não existe; os snapshots divergem antes da atualização |
| Documento | Dona de `CONTROL_SURFACE.md` (erros novos, resultado de `hooks.approve`, recusa de `fresh`, `link.create`) |
| Limite | Dois arquivos de handler, nenhum com mais de 300 linhas; complexidade por função abaixo de 10 (o mapa de erro é uma tabela) |

#### Etapa 2b: identidade do serviço

Objetivo: gravar `servicePid` e `serviceTokenSha256` da ligação, para o limpador de órfão do boot ter entrada real. Decisões de porta no registro do arquiteto de 10/11/2026.

| Item | Valor |
| --- | --- |
| Aceite que fecha | `serviceIdentity()` devolve `{ pid, tokenSha256 }` com o hash igual a `sha256(token)` e sem o token em claro (o teste varre o objeto serializado); devolve `null` com pid `-1`, `0` ou `1` e sem serviço; depois de `startExecutorService` com runtime falso a ligação lida do repositório tem as duas colunas, e depois de `executor.recovered` com identidade nova as colunas mudam, sem segundo `update` com identidade igual; falha de `serviceIdentity` ou de `update` não faz o spawn falhar; reaper com pid vivo e hash errado não mata, com hash certo mata o grupo, e com pid `<= 1` não chama `killGroup` |
| Regra | `recordServiceIdentity(ctx, linkId, runtime)` em `application/serviceIdentity.ts` (menos de 60 linhas) chama `runtime.serviceIdentity()` e, se diferente do gravado, `updateLink`. Pontos de chamada: `startExecutorService` (depois de `ensureSession`, antes de `executor.ready`) e o ramo `executor.recovered` de `reconcileOnBoot.ts`. Fechar a ligação não limpa as colunas |
| Testes | `serviceIdentity.spec.ts` (gravação e idempotência); casos de identidade em `CodexExecutorRuntime.spec.ts`; casos do reaper (pid reciclado, pid `0`, `1` e `-1`, hash igual com SIGTERM e SIGKILL após `TERM_GRACE_MS`) |
| Vermelho esperado | `serviceIdentity.spec.ts` falha por módulo ausente; os casos novos do runtime falham porque `serviceIdentity` não existe; os casos de pid inválido do reaper falham porque `reapOne` com pid `1` chama `killGroup(1)` |
| Limite | `CodexExecutorRuntime.ts` medido com `wc -l` antes; acima de 290 linhas, extrair para `codexServiceIdentity.ts`. Nenhum arquivo acima de 300 linhas, complexidade por função abaixo de 10. Todo fake de runtime implementa o método |
| Fechamento | `pnpm arch:test` e `pnpm verify:quick` verdes |

#### Etapa 4r: adaptador do run state

Objetivo: dar implementação à porta `ExecutorRunStateIngress` de `application/ports/hostPorts.ts`, obrigatória em `OrchestrationDeps.runState`, que não tinha nenhuma.

| Item | Valor |
| --- | --- |
| Aceite que fecha | `createExecutorRunStateAdapter` implementa a porta sobre a classe por sessão do F2-07 (`executorRunStateIngress.ts`, intocada) e sobre o arquivo de turnos que `agent read --turn` lê; a mensagem final do turno é achada pelo `glimpseTurnId`; o lease é cancelado na troca de sessão |
| Regra | Entrada única do run state `executor_service`: só o adaptador. A 4b1 não alimenta a classe por evento, e não há stub. A 4a consome a função com a interface de dependências que a 4r exporta |
| Testes | `executorRunStateAdapter.spec.ts` (9 casos) |
| Vermelho esperado | O spec falha por import ausente |
| Limite | `executorRunStateAdapter.ts` com no máximo 300 linhas |

#### Etapa 4s: porta do run state

Objetivo: fechar duas lacunas da porta achadas pela 4a. Decisões em `decisoes-porta-runstate.md` do arquiteto, de 10/11/2026.

| Item | Valor |
| --- | --- |
| Aceite que fecha | `recordWaitingForApproval(executorNodeId, requestId, summary)` recebe o resumo real da aprovação (único chamador: `recordApprovalEvent` em `approvals.ts`), e o `blockedSummary` do alerta do shell exibe esse resumo; `recordExecutorRecovered(executorNodeId)` é chamado em `handleExecutorIncident` de `reconcileOnBoot.ts` no ramo que não é `executor.down`, e o run state sai de `unknown` na recuperação |
| Regra | A recuperação sem `down` anterior é no-op do ingress. A porta ganha só essas duas assinaturas |
| Testes | `approvals.spec.ts` espera o resumo; `reconcileOnBoot.spec.ts` cobre o ramo `recovered`; `executorRunStateAdapter.spec.ts` cobre o novo argumento e a recuperação |
| Vermelho esperado | Seis falhas antes da mudança, por assinatura e por método ausente |
| Limite | Fora da etapa: `linkLifecycle.ts` e `dispatchPump.spec.ts` (o `down` não muda) |

#### Etapa 4a: montagem

Objetivo: construir o serviço real no Worker e entregá-lo aos handlers.

| Item | Valor |
| --- | --- |
| Aceite que fecha | Serviço real construído no Worker e entregue aos handlers pelo `registerControlSurfaceHandlers.ts`; o objeto devolvido por `orchestration()` expõe `reviveExecutorTui(nodeId): Promise<string | null>` (sessionId da TUI viva depois do relançamento, ou `null` sem ligação ativa de serviço), que a 4c só consome; `BEGIN IMMEDIATE` fora de transação aberta |
| Pendências que fecha | Conexão better-sqlite3 própria no `dbPath` (WAL já persistente; `busy_timeout = 5000` repetido por conexão; nunca dentro de `PersistenceStore.write`); repositórios; `CodexExecutorRuntimeFactory` com `startProcess`, `PortReserver` real sobre `reserveLoopbackPort` de `sessionLaunchSupport.ts` (sem host), `resolveExecutable`, `createClient`, `approvedHooks` do repositório de aprovações e `readFullAccess` lido das configurações no start; `resolveCodexExecutable`; `createExecutorNode` com `placeExecutorNode`; `liveSessionOf` e `bindSession`; lançador de TUI; descarte no stop do Worker; `runState` é o `createExecutorRunStateAdapter` da 4r |
| Testes | `composition.spec.ts` com SQLite real e runtime falso: montagem, entrega aos handlers e `BEGIN IMMEDIATE` fora de transação aberta |
| Vermelho esperado | `composition.spec.ts` falha por módulo ausente |
| Limite | `composeOrchestration.ts` e `composeOrchestrationDeps.ts` com no máximo 300 linhas cada, divididos por tipo de dependência; `controlSurfaceHttpRuntime.ts` (484 linhas, teto 500) ganha no máximo 6 linhas |

#### Etapa 4b1: eventos

Objetivo: ligar supervisor, prontidão, espelho e saúde ao serviço composto.

| Item | Valor |
| --- | --- |
| Aceite que fecha | `watchReadiness` ligado ao `noticePump` e ao `LinksUpdatedEvent` (com `operationId` e `revision`); `subscribeEvents` ligado a `supervisor.handle`, com `onNotice` no `pump.poke`; `deliveryInFlight` ligado a `inFlight`; `inputWatermark` do hub de PTY; espelho da etapa 1 (`createOrchestrationLinksMirror` com `writeOrchestrationLinksMirror`, `healthOf`, publicador, `IdGenerator` e `readAppStateRevision`) a cada mudança de ligação e na reconciliação; `subscribeHealth` publica `orchestration.links.updated` ao entrar e sair de `unavailable`; `executor.down` com `restarts_exhausted` vira `service.unavailable` |
| Testes | `compositionEvents.spec.ts` com SQLite real e runtime falso |
| Vermelho esperado | O spec falha por módulo ou ligação ausente |
| Limite | `composeOrchestrationEvents.ts` recebe a parte de eventos para `composeOrchestration.ts` ficar em até 300 linhas; `controlSurfaceHttpRuntime.ts` ganha no máximo 4 linhas líquidas, passando dependência por objeto único |
| Fora do escopo | A instância única de `PromptDeliveryService` ficou para a 4d (entregue, ver abaixo) |

#### Etapa 4b2: boot e descarte

Objetivo: iniciar os serviços no start do Worker e pará-los no stop, na ordem do O8.

| Item | Valor |
| --- | --- |
| Aceite que fecha | O boot dispara no start do Worker (`void orch.boot()` em `controlSurfaceHttpRuntime.ts`), sem esperar o primeiro `get`: reconciliação, `reapOrphanServices` com `CodexOrphanReaper`, sincronização inicial do espelho, `pump.poke` e relançamento da TUI de todo executor ativo sem PTY vivo; `service.shutdown()` fecha cada serviço com `ExecutorCloseReason` `'shutdown'` (`turn/interrupt` se houver turno, SIGTERM, 3 s e SIGKILL no grupo, sem `thread/archive`), sem fechar a ligação, sem marcar `unavailable`, sem aviso ao orquestrador e sem reinício com recuo; `dispose` é assíncrono e o runtime faz `await orch.dispose()` |
| Regra | Ordem do descarte: desliga eventos, bomba e supervisor, depois `service.shutdown()` (fechamentos em paralelo), depois fecha a conexão. A lógica fica em `application/serviceShutdown.ts`, padrão de `linkCreate.ts` e `executorTuiRelaunch.ts`; a porta `ExecutorRuntime` não muda e o wrapper de factory ficou descartado |
| Testes | `serviceShutdown.spec.ts`; `compositionBoot.spec.ts` com `lazyOrchestration` (nulo sem `dbPath`, composição no primeiro `get`, `get` nulo após o descarte), composição com `events` (publicação após `createLink`, aviso após evento do executor), `restarts_exhausted` com um único `enqueue` e a ordem do boot |
| Vermelho esperado | Os specs falham por módulo ou método ausente |
| Limite | `OrchestrationService.ts` sobe de 290 para no máximo 300 linhas (só o delegador `shutdown`); `controlSurfaceHttpRuntime.ts` ganha no máximo 4 linhas líquidas e pode ceder linhas da orquestração a um módulo de `orchestration/` |

#### Etapa 4c: revive

Objetivo: reabrir o nó do executor revive a TUI ligada, sem shell órfão.

| Item | Valor |
| --- | --- |
| Aceite que fecha | Reabrir o nó do executor chama `reviveExecutorTui(node.id)` antes de `spawnFallbackTerminal`, dentro do `try` existente; com sessionId não nulo o retorno é antecipado com `recoveryState: 'restarted'` e o sessionId da TUI, sem shell; com `null` o caminho do shell fresco segue; erro em `reviveExecutorTui` cai no `catch` existente (`sessionId: ''` com `lastError` recuperável), sem queda para shell fresco, que criaria órfão ao lado de um serviço possivelmente vivo |
| Regra | Sem ponte de módulo: a dependência entra por injeção pela cadeia real `registerControlSurfaceHandlers` > `sessionHandlers.ts` (`registerSessionHandlers`) > `sessionPrepareOrReviveHandler.ts` (que chama `prepareTerminalNode`) > `sessionPrepareOrReviveTerminalPreparation.ts`; `sessionPrepareOrRevivePreparation.ts` só reexporta. A opção `reviveExecutor` de `sessionPrepareOrReviveTerminalAgent.ts` é removida (código morto: ela receberia o sessionId de um shell já criado) |
| Testes | `sessionPrepareOrReviveExecutor.spec.ts`: com ligação ativa o shell fresco não é criado e o resultado traz o sessionId da TUI; sem ligação cai no shell fresco; erro de revive devolve resultado recuperável sem shell. O bloco `reviving an executor node` de `executorTui.spec.ts` sai, e a cobertura passa ao spec novo |
| Vermelho esperado | Duas falhas antes da implementação |
| Limite | `sessionHandlers.ts` (498 linhas) ganha no máximo 4 linhas líquidas, de preferência carregando a dependência num objeto de deps existente. `isLiveSessionReattach` vale `true` no retorno antecipado, porque a TUI já está viva no Worker quando o resultado chega |

#### Etapa 5: autorização e CLI

Objetivo: provar a matriz com grants reais e fechar os atalhos.

| Item | Valor |
| --- | --- |
| Aceite que fecha | I-01 verde com grants reais; `agent.prompt` e `session.writeNode` de principal de agente contra executor ligado devolvem `orch.use_dispatch`, sem escrita no PTY (guarda em `handlers/directInputGuard.ts`); `principalOf` lê `grantActive` de `ctx.assertActive` |
| Pendências que fecha | Conferir os `render.fields` da CLI de interrupt, close, link close, approval respond, hooks approve, link extend e link create |
| Testes | I-01 em `authorization.spec.ts`; `cliOrch.spec.ts` com o resultado real de cada handler |
| Vermelho esperado | `authorization.spec.ts` falha enquanto o atalho do `agent.prompt` escreve no PTY |
| Fora do escopo | I-07 (exclusão de nó) e o teste do espelho forjado por `sync.writeState` passam à 5b |
| Fechamento | `pnpm arch:test` e `pnpm verify:quick` verdes, inclusive a sincronia dos documentos de contrato |

#### Etapa 5b: exclusão de nó (entregue)

Objetivo: fechar toda ligação cujo nó executor ou orquestrador sumiu do estado, reconciliador que o ADR prevê (`onStatePersisted` e boot) e que a etapa 5 não entregou.

| Item | Valor |
| --- | --- |
| Aceite que fecha | I-07 verde: método no serviço, com a lógica em módulo novo de aplicação sobre `closeExecutorLink(..., 'node_deleted')`, fecha a ligação cujo nó sumiu; ligado a `onStatePersisted` e ao boot; cancela `queued` com a rodada devolvida, interrompe o turno, encerra o serviço com `thread/archive` antes do SIGTERM, regrava o espelho e publica; escrita forjada via `sync.writeState` não muda `orch.dispatch` |
| Testes | `nodeDeletion.spec.ts` e o teste do I-01 do espelho forjado |
| Vermelho esperado | `nodeDeletion.spec.ts` falha por método ausente |
| Limite | `OrchestrationService.ts` até 300 linhas; `composeOrchestration*.ts` herdado da 4b2 |
| Entregue | O reconciliador `reconcileDeletedNodes` (`application/nodeDeletion.ts`) roda em `onStatePersisted`, depois de `node.delete` (embrulho `notifyAfterStateWrite` em `orchestration/nodeDeletionTrigger.ts`, que notifica depois de `writeAppState` ok) e no boot (`reconcileOnBoot`, depois do reaper e antes de `reconcileLink`). O estado vem do store; leitura que falha ou estado sem workspace não fecha ligação. `reconcileOnBoot` consulta `isStopped` antes de cada ligação. Limite: só o caminho SQLite local do renderer (`sqlite/ipc/register.ts`, que existe apenas em modo standalone, desligado por `allowStandaloneMode: false`) não dispara o reconciliador; em produção a escrita do renderer passa por `createRemotePersistenceStore` e `sync.writeState`, que chama `onStatePersisted` |

##### Rodada 1 da 5b: grant de agente não escreve o estado

Antes da rodada, um grant de agente (`interact`) chamava `sync.writeState` e `sync.writeWorkspaceStateRaw`, podia omitir nós de outro projeto e, com a 5b, fechar as ligações e encerrar os serviços. As duas rotas passam a ser negadas a `session-grant` em `sessionGrantAuthorization.ts`, nos dois níveis, e o ADR (seção "Sincronização com o renderer") e o `CONTROL_SURFACE.md` registram a regra. O teste do I-01 usa estado forjado não vazio e afirma `common.forbidden`.

O cliente web e o desktop não autenticam como `session-grant`, então a negativa não os atinge. Fica para card próprio de segurança: `node.delete` e `node.update` por grant aceitam `nodeId` de qualquer projeto, falha anterior à 5b.

#### Etapa 4d: entrega única de prompt (entregue)

Objetivo: uma instância de `PromptDeliveryService` compartilhada entre `registerAgentPromptHandlers` e a orquestração, para aviso e `agent.prompt` não colarem ao mesmo tempo no PTY do orquestrador.

| Item | Valor |
| --- | --- |
| Aceite que fecha | A reserva do PTY vive na instância (`PromptDeliveryService.ts:93,108`), então as duas rotas passam a disputar a mesma reserva; achado da revisão da 4b1 |
| Testes | Spec de composição em que aviso e `agent.prompt` concorrentes não se misturam no input |
| Vermelho esperado | O spec falha enquanto há duas instâncias |
| Limite | Depois da 4b2, da 5 e da 5b, porque divide com elas o handler de `agent.prompt` e `composeOrchestration*.ts` |
| Entregue | `controlSurfaceHttpRuntime.ts` cria uma única instância por Worker com `createAgentPromptDelivery` e a repassa a `registerControlSurfaceHandlers` (para `registerAgentPromptHandlers`) e a `lazyOrchestration`. Aviso da bomba e `agent.prompt` respeitam a mesma reserva do PTY |

#### Etapa de documentos

`ARCHITECTURE.md` (composição no Worker), `RECOVERY_MODEL.md` (boot e stop do Worker), `CONTROL_SURFACE.md` (`orch.use_dispatch`) e este arquivo, em paralelo com a 4d. O E7 passa a registrar `OrchestrationService.ts` em até 300 linhas.

## Adiados

| Item | Destino | Motivo |
| --- | --- | --- |
| Corrida entre recusa da entrega e nova assinatura da prontidão | Fase 3 | Reler a prontidão criaria laço quente (lição da onda 3) |
| `model` nulo ao religar | Fase 3 | Limite registrado da fase 2 |
| `usage` do turno nulo | Fase 3 | Sem consumidor na fase 2 |
| Itens "depois" do núcleo, do aviso, do Codex, do alerta e da TUI | Fase 3 | Nenhum toca arquivo do F2-14 |
| `ctx.wake` de `approveHooks` | Só documentação | Decisão de 10/11/2026: exceção documentada no ADR, sem código |
