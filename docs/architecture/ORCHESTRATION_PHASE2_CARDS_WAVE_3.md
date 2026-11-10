# Partição da fase 2: onda 3

Parte da [partição da fase 2](ORCHESTRATION_PHASE2_CARDS.md), que traz as regras de execução, o diagrama, as outras ondas e a tabela de arquivos que mudam de dono. Este arquivo guarda os cards da onda 3. Os testes citados por id (U, C, I, E) estão em [Riscos e testes](ORCHESTRATION_RISKS_AND_TESTS.md).

## Onda 3

Ordem de execução:

1. Já, em paralelo: F2-08b etapa 1, F2-09b, F2-13 e F2-17a. O F2-17b começa depois do F2-17a aprovado.
2. Depois da etapa 1 aprovada: F2-08b etapa 2 e F2-11 em paralelo. O F2-11 só consome o tipo `ApprovalDecision`.
3. Depois do F2-08b inteiro aprovado: F2-12, que é dono de `OrchestrationService.ts` (com `subscribeEvents` aditivo), de `fakes.ts` e de `linkLifecycle.ts` se precisar.

### F2-08b Correção holística do núcleo

Card da onda 3, aprovado pelo Bruno em 09/11/2026. Complementa o F2-08. Os caminhos são de `src/contexts/orchestration/application/` salvo indicação. Linhas citadas valem para o commit `2ff2f67e`. O card é grande demais para um agente só (o F2-08 parou em 152k de contexto), então roda em duas etapas sequenciais: a etapa 2 só abre com a etapa 1 aprovada.

| Campo | Valor |
| --- | --- |
| Objetivo | Eliminar as sete causas raiz das oito falhas das revisões do F2-08, com teste vermelho por falha |
| Papel | dev-backend |
| Depende de | F2-08 e F2-05 |

| Etapa | Causas raiz | Testes | Arquivos donos |
| --- | --- | --- | --- |
| 1 | RC1, RC6, RC7 e o tipo `ApprovalDecision` de RC5 | T1, T2, T3, T4, T13, T14, T17, T18, T19 | `ports/dispatchLedger.ts` (novo), `ports/index.ts`, `ports/repositories.ts`, `ports/executorRuntime.ts` (só `ApprovalDecision`); `infrastructure/persistence/SqliteDispatchLedger.ts` (novo), `SqliteDispatchRepository.ts`, `SqliteAgentLinkRepository.ts`, `SqliteNoticeOutboxRepository.ts`, `sqliteHandle.ts` (só helpers síncronos); `dispatchToExecutor.ts` (inclui tirar `fresh` de `DispatchInput`), `spawnExecutor.ts`, `linkLifecycle.ts` (`extendLinkRounds` por delta), `approvals.ts` (mapa 1 para 1 das quatro decisões); `domain/dispatch.ts` (`assertDispatchText`); `fakes.ts`, `dispatchLedgerContract.ts` (novo) e specs de aplicação tocados; `tests/unit/contexts/orchestration/domain/dispatch.spec.ts`; `tests/integration/orchestration/persistence/SqliteDispatchLedger.spec.ts` (novo) |
| 2 | RC2, RC3, RC4 e o resto de RC5 | T5 a T12, T15, T16 | `dispatchPump.ts`, `OrchestrationService.ts` (máx. 270 linhas), `reconcileOnBoot.ts`, `hookApprovals.ts`, `approvals.ts`, `runtimeErrors.ts` (novo), `executorSlots.ts` (novo, se o limite exigir), `spawnExecutor.ts` (só a saída de `asOrchestrationError`), `dispatchToExecutor.ts` (só `callRuntime` em `interrupt`), `linkLifecycle.ts` (só `callRuntime` em `close` e `notice: 'none'` no `send_uncertain` de `failOpenDispatch`); specs de aplicação |

O `settleDispatch` do ledger já nasce na etapa 1 com o parâmetro `notice: 'final' | 'none'`; a etapa 2 só passa a usá-lo nos pontos de RC4.

Fica de fora dos donos: `src/shared/contracts/controlSurface/operations/domains/orch.ts` (declaração de `errors` e recusa de `fresh`, que passam ao F2-14).

#### Método

Cada falha passa por cinco porquês com evidência de código. As falhas são agrupadas pela raiz que, corrigida, impede a falha e as irmãs. As hipóteses da passagem foram testadas contra o código: duas foram confirmadas, duas foram ampliadas e uma foi derrubada em parte.

#### Cinco porquês por falha

##### Falha 1: extensão de rodadas revertida por despacho concorrente

| # | Pergunta | Resposta | Evidência |
| --- | --- | --- | --- |
| 1 | Por que a extensão some? | A gravação do despacho espalha `rounds` calculado antes sobre a ligação atual e restaura o `roundsLimit` velho | `dispatchToExecutor.ts:85` |
| 2 | Por que `rounds` é velho? | `createDispatch` recebe a ligação lida no topo do caso de uso e devolve o contador derivado dela | `dispatchToExecutor.ts:101,72`; `domain/dispatch.ts:91` |
| 3 | Por que o contador viaja entre duas gravações? | O `round` do despacho depende do contador, e despacho e ligação são gravados por duas portas separadas | `dispatchToExecutor.ts:80,85`; `ports/repositories.ts:28,44` |
| 4 | Por que a extensão consegue entrar no meio? | `extendRounds` não passa pela exclusão do executor, só pelo CAS da ligação | `OrchestrationService.ts:152-158`; `linkLifecycle.ts:211-222` |
| 5 | Por que o CAS não protege? | O CAS compara `revision`, mas o callback ignora o valor fresco e grava campos de um snapshot anterior | `linkLifecycle.ts:45-46` |

Causa raiz: RC1. O fato "despacho aceito e rodada consumida" é um fato só, gravado em passos, com valor derivado carregado entre eles. O devolver da rodada em `settleDispatch` já usa o valor fresco (`linkLifecycle.ts:146-149`), o que mostra o padrão certo.

##### Falha 2: spawn com identidade global e duas gravações

| # | Pergunta | Resposta | Evidência |
| --- | --- | --- | --- |
| 1 | Por que o mesmo `requestId` de outro orquestrador gera `orch.dispatch_conflict`? | O `dispatchId` é `uuidV5(requestId)`, global, e o despacho do primeiro orquestrador já ocupa o id | `spawnExecutor.ts:186`; `domain/dispatch.ts:274-281` |
| 2 | Por que a idempotência do spawn é por orquestrador e o id do despacho é global? | A busca e o índice único usam `(orchestrator_node_id, spawn_request_id)`, e só o id do despacho ignora o orquestrador | `spawnExecutor.ts:170`; `orchestrationTables.ts:123-124` |
| 3 | Por que o erro aparece depois de criar nó, ligação e serviço? | A validação do texto e a classificação rodam em `acceptDispatch`, depois dos efeitos | `spawnExecutor.ts:123,146,177,185`; `domain/dispatch.ts:84-90` |
| 4 | Por que a falha entre ligação e despacho perde o prompt? | A ligação é o marcador de idempotência, e o ramo `known` nunca cria o despacho inicial que faltou | `spawnExecutor.ts:170-172,90-104` |
| 5 | Por que o marcador e o seu conteúdo são gravados separados? | Não existe operação de porta que insira ligação e primeiro despacho juntos, e o serviço sobe entre as duas | `spawnExecutor.ts:146,175-190`; `ports/repositories.ts:28-56` |

Duas raízes. O conflito entre orquestradores é RC7 (escopo da identidade). O prompt perdido é RC1 (gravação em passos).

##### Falha 3: aceite do turno sem assentamento

| # | Pergunta | Resposta | Evidência |
| --- | --- | --- | --- |
| 1 | Por que o despacho pode ficar `reserved` com o turno em curso? | Falha do assentamento `service_accepted` cai no `catch` do envio | `dispatchPump.ts:73-82` |
| 2 | Por que o `catch` erra? | Ele trata erro de gravação como erro de transporte e tenta `send_uncertain` | `dispatchPump.ts:80-81` |
| 3 | Por que a segunda tentativa falha? | Reusa o objeto `reserved` lido antes; se a primeira gravação já tinha confirmado, a `revision` esperada é velha, e `saveDispatch` lança | `dispatchPump.ts:81`; `linkLifecycle.ts:70-77` |
| 4 | Por que nada corrige depois? | Eventos de turno só assentam despacho em `sent` ou `uncertain`, nunca em `reserved` | `dispatchPump.ts:107,129` |
| 5 | Por que o registro interno depende de uma só fonte? | O fato externo (executor aceitou) chega por duas vias, o retorno de `startTurn` e `turn.started` com `dispatchId`, e só a primeira é usada | `dispatchPump.ts:74-78,98-110`; `ports/executorRuntime.ts:114-119` |

Verificação da passagem: "fica `reserved` até o boot" vale só com falha persistente de gravação (as duas tentativas). Com falha única de leitura depois do commit, o estado fica `sent` e o erro sobe ao `onBackgroundError`. Causa raiz: RC2. A hipótese "sem unidade atômica" foi derrubada para esta falha, porque `startTurn` é efeito externo e não cabe em transação.

##### Falha 4: bomba que não acorda ou ignora o reinício

| # | Pergunta | Resposta | Evidência |
| --- | --- | --- | --- |
| 1 | Por que o reinício por hook pode ficar adiado para sempre? | A bomba envia o próximo `queued` antes de `restartIfIdle` olhar | `OrchestrationService.ts:265-269`; `dispatchPump.ts:154-156` |
| 2 | Por que a bomba ignora `restartPending`? | A guarda confere `runtime`, saúde e voo, mas não `restartPending` | `dispatchPump.ts:46-52` |
| 3 | Por que a falha de start do reinício não acorda a bomba? | O `catch` emite `service.unavailable` por `onRuntimeEvent`, que sai cedo para tipo fora do conjunto | `hookApprovals.ts:44-47`; `OrchestrationService.ts:243-245` |
| 4 | Por que há tipos fora do conjunto? | O conjunto `RUNTIME_EVENT_TYPES` é uma lista manual de quem acorda, paralela ao `foldExecutorHealth` | `OrchestrationService.ts:90-99`; `executorHealth.ts:37-62` |
| 5 | Por que a regra de acordar está espalhada? | Cada caminho decide sozinho: `markExecutorUnavailable` chama a bomba à mão, o boot chama `finishBoot`, o ADR lista cinco gatilhos | `OrchestrationService.ts:161-164,180-185`; `ADR-orchestration-dispatch-and-surface.md:107` |

Causa raiz: RC3, hipótese confirmada. A decisão de reiniciar e a de enviar vivem em lugares diferentes, e o sinal de acordar é lista manual.

##### Falha 5: aviso `uncertain` em transição intermediária

| # | Pergunta | Resposta | Evidência |
| --- | --- | --- | --- |
| 1 | Por que o aviso sai antes de a reconciliação resolver? | O passo 1 do boot assenta `send_uncertain` e esse assentamento já gera aviso | `reconcileOnBoot.ts:63-68,93` |
| 2 | Por que todo assentamento gera aviso? | `settleDispatch` enfileira aviso para o estado resultante, qualquer que seja o chamador | `linkLifecycle.ts:141-152` |
| 3 | Por que o estado decide o aviso? | `noticeKindOf` mapeia `uncertain` direto a um tipo de aviso | `linkLifecycle.ts:80-85` |
| 4 | Por que o chamador não distingue passagem de ponto final? | `settleDispatch` não tem parâmetro de política, então `failOpenDispatch` emite `uncertain` e depois `executor_down` | `linkLifecycle.ts:171-174` |
| 5 | Por que a regra do ADR não está no código? | O ADR manda aviso nas transições finais do passo 5, mas a política está implícita no mapa estado a tipo | `ADR-orchestration-dispatch-and-surface.md:175` |

Causa raiz: RC4, hipótese confirmada e ampliada: `failOpenDispatch` e `handleExecutorIncident` (`reconcileOnBoot.ts:107`) são irmãs.

##### Falha 6: despacho inserido antes de consumir a rodada

| # | Pergunta | Resposta | Evidência |
| --- | --- | --- | --- |
| 1 | Por que a queda no meio deixa `queued` sem rodada consumida? | `insert` do despacho e `updateLink` da rodada são duas chamadas | `dispatchToExecutor.ts:80,85` |
| 2 | Por que são duas chamadas? | Cada repositório abre a própria transação e a porta não tem operação que cruze os dois | `SqliteAgentLinkRepository.ts:209-219`; `SqliteDispatchRepository.ts:98-120` |
| 3 | Por que a porta não tem essa operação? | As portas foram desenhadas por agregado, com CAS por `revision` em cada um | `ports/repositories.ts:5-9,28-56` |
| 4 | Por que isso já deixou rastro? | O esquema 14 traz um reparo que devolve rodadas de `queued` excedentes | `orchestrationTables.ts:22-41` |
| 5 | Por que a devolução e o aviso repetem o problema? | `settleDispatch` grava o despacho, depois a rodada, depois o aviso, em três passos | `linkLifecycle.ts:141-152` |

Causa raiz: RC1. Corrigir só o aceite deixaria a devolução assimétrica, então `settle` entra na mesma operação atômica.

##### Falha 7: aprovação sem tradução de erro

| # | Pergunta | Resposta | Evidência |
| --- | --- | --- | --- |
| 1 | Por que runtime nulo vira `orch.approval_not_found`? | O ramo cria `{ ok: false }` e o caminho único de falha lança esse código | `approvals.ts:33-39` |
| 2 | Por que o erro do runtime sobe cru? | `respondApproval` do runtime não é envolvido por tradução | `approvals.ts:34` |
| 3 | Por que não há tradução? | `asOrchestrationError` é privada de `spawnExecutor.ts` e só vale em duas chamadas | `spawnExecutor.ts:27-35,114,181` |
| 4 | Por que outros pontos ficaram sem? | `interrupt`, `probe` do reinício e `close` chamam o runtime sem tradução | `dispatchToExecutor.ts:147`; `spawnExecutor.ts:83`; `linkLifecycle.ts:207` |
| 5 | Por que a porta permite isso? | O contrato diz que toda operação rejeita com código `executor.*`, mas nenhum módulo único o converte | `ports/executorRuntime.ts:13-21` |

Causa raiz: RC5, hipótese confirmada.

##### Falha 8: fake mais permissivo que o banco

| # | Pergunta | Resposta | Evidência |
| --- | --- | --- | --- |
| 1 | Por que o ramo `saveDispatch` nulo não tem teste? | O fake nunca devolve `in_flight_conflict` | `tests/.../fakes.ts:133-143` |
| 2 | Por que o fake não devolve? | Ele só repete CAS e `executor_busy` no insert; a regra de mover para `reserved` só existe no SQLite | `fakes.ts:121-131`; `SqliteDispatchRepository.ts:122-125,166-175` |
| 3 | Por que a regra só existe no SQLite? | A porta descreve `in_flight_conflict` em comentário, sem teste executável | `ports/repositories.ts:46-47` |
| 4 | Por que não há teste executável da porta? | O spec de integração cobre o SQLite e os specs de aplicação cobrem o fake, sem suíte comum | `tests/integration/orchestration/persistence/SqliteDispatchRepository.spec.ts` |
| 5 | Por que o desvio passou nas revisões? | Cada implementação da porta é validada só contra si mesma | idem |

Causa raiz: RC6, hipótese confirmada.

#### Agrupamento por causa raiz

| RC | Causa | Falhas | Hipótese da passagem |
| --- | --- | --- | --- |
| RC1 | Fato composto (despacho com rodada, ligação com primeiro despacho, despacho final com devolução e aviso) gravado em passos, com valor derivado carregado entre eles | 1, 6, 2 (prompt perdido) | Ampliada: a 1 entra aqui, não é causa isolada |
| RC2 | Fato externo (o executor aceitou o turno) registrado por uma só via, sobre snapshot velho e classificado como erro de transporte | 3 | Derrubada em parte: não é falta de atomicidade |
| RC3 | Regra de acordar e de reiniciar espalhada, sem lugar único | 4 | Confirmada |
| RC4 | Aviso acoplado a qualquer transição, sem política de assentamento | 5 | Confirmada |
| RC5 | Erro do runtime sem ponto único de tradução | 7 | Confirmada |
| RC6 | Fake sem contrato compartilhado com a implementação real | 8 | Confirmada |
| RC7 | Identidade e validação do spawn decididas depois dos efeitos, com escopo diferente da unicidade | 2 (conflito entre orquestradores) | Nova |

#### Correção por raiz

##### RC1: porta atômica `DispatchLedger`

Mudança de porta aprovada. Nova porta em `ports/dispatchLedger.ts`, exportada por `ports/index.ts`, implementada por `SqliteDispatchLedger.ts` sobre o mesmo handle. Cada operação roda síncrona dentro de um `BEGIN IMMEDIATE`, sem `await` no meio, porque transação aberta entre `await` deixaria outro executor escrever dentro dela.

| Operação | Efeito atômico | Resultado |
| --- | --- | --- |
| `acceptDispatch(dispatch)` | Lê a ligação, recusa se inativa ou sem rodada, incrementa `rounds_used` no banco (delta, nunca valor absoluto), define `dispatch.round` com o valor novo, insere o despacho e sobe `linksRevision` | `{ ok, dispatch, link }` ou `link_not_active`, `round_limit_reached`, `id_exists`, `executor_busy` |
| `createLinkWithDispatch(link, dispatch ou null)` | Insere a ligação e, com despacho, aplica `acceptDispatch` na mesma transação | Como `insert` de ligação, mais os motivos do aceite |
| `settleDispatch({ next, refundRound, notice })` | CAS do despacho com a regra `in_flight_conflict`, devolução da rodada por delta (`MAX(0, rounds_used - 1)`) e `INSERT OR IGNORE` do aviso | `{ ok, dispatch, link, noticeEnqueued }`, `revision_conflict`, `not_found` ou `in_flight_conflict` |

Regras:
- `extendLinkRounds` passa a delta no banco (`rounds_limit + n`) por método do mesmo `AgentLinkRepository` ou do ledger, e entra sob a exclusão do executor.
- O spawn cria nó e serviço depois de validar. Com prompt, a ligação nasce com o despacho `queued` pelo `createLinkWithDispatch`, antes de subir o serviço. A bomba envia quando o executor fica `ready`. Falha de start fecha a ligação por `closeExecutorLink` e cancela o `queued` com devolução.
- Os repositórios existentes extraem helpers síncronos de linha para o ledger não duplicar SQL. Arquivo acima de 300 linhas exige justificativa no relatório do dev.

##### RC2: assentamento sobre leitura fresca

- O `try` do envio cobre só `startTurn`. O assentamento sai do `try`.
- Helper `settleFresh` reler o despacho por id e reaplica o evento, até 3 tentativas, sem reusar o objeto antigo.
- Falha de gravação nunca vira `send_uncertain`. Só erro de transporte classificado por `runtimeErrors.ts` produz `service_rejected` ou `send_uncertain`.
- `onTurnStarted` assenta `service_accepted` quando o despacho está `reserved` e o `dispatchId` do evento confere. `onTurnCompleted` faz `service_accepted` seguido de `turn_finished` nesse caso.

##### RC3: acordar e reiniciar numa regra

- `onRuntimeEvent` compara `executorHealthOf` antes e depois do `fold`. Toda mudança de saúde derivada e toda mudança de `restartPending` agenda uma passada da bomba. `RUNTIME_EVENT_TYPES` deixa de decidir quem acorda e só decide quem vai a `routeEvent`.
- `pumpExecutor` ganha a ordem: `unavailable` falha o aberto; `restartPending` sem despacho em voo reinicia antes de enviar; só então reserva e envia.
- `restartIfIdle` deixa de ser chamado só no `turn.completed`.
- O ADR passa a listar o gatilho (edição pedida em `decisoes-arquiteto-a.md`).

##### RC4: política de assentamento

- `settleDispatch` recebe `notice: 'final' | 'none'` e envia o aviso só em estado final com `final`. O aviso de `uncertain` sai só de dois pontos explícitos: `send_uncertain` do envio em tempo de execução e o ramo `unknown` de `resolveInFlight`.
- `markReservedUncertain` e o `send_uncertain` intermediário de `failOpenDispatch` passam `none`.
- O ledger recebe o aviso já decidido, sem ler o estado.

##### RC5: ponto único de tradução

- Novo `runtimeErrors.ts` com `translateRuntimeError` e `callRuntime`, e a tabela `REFUSED_BEFORE_WRITE` movida do `dispatchPump.ts`. `asOrchestrationError` sai do `spawnExecutor.ts`.
- Todas as chamadas ao runtime fora do envio passam por `callRuntime`: `respondApproval`, `interrupt`, `probe` do reinício e `close`.
- Runtime nulo em `respondApproval` lança `orch.executor_unavailable`.
- `ApprovalDecision` em `ports/executorRuntime.ts` passa a `'approve' | 'approve_for_session' | 'deny' | 'cancel'`. `cancel` recusa e interrompe o turno. `approvals.ts` mapeia 1 para 1, e `FakeRuntime` aceita os quatro valores.

##### RC6: suíte de contrato

- `fakes.ts` implementa `InMemoryDispatchLedger` com as mesmas regras e `in_flight_conflict` no `update`.
- Helper `dispatchLedgerContract.ts` em `tests/unit/contexts/orchestration/application/` exporta `describeDispatchLedgerContract(nome, fábrica)`, rodado contra o fake (spec de unidade) e contra o SQLite real (`SqliteDispatchLedger.spec.ts`, handle `node:sqlite`).

##### RC7: identidade e validação do spawn

- `dispatchId` inicial = `uuidV5(\`${orchestratorNodeId}:${requestId}\`)`, nos dois pontos de uso (`spawnExecutor.ts:95,186`).
- `assertDispatchText(text)` exportado por `domain/dispatch.ts` e usado por `createDispatch`. O spawn o chama antes de `createExecutorNode`.

#### Testes vermelhos esperados

Cada teste é escrito e visto falhar antes do código de produção; o log da linha vermelha vai ao relatório.

| # | Falha | Teste | Onde | Vermelho hoje |
| --- | --- | --- | --- | --- |
| T1 | 1 | `extendRounds` entre a leitura e a gravação do aceite preserva o limite novo | `dispatchToExecutor.spec.ts` | limite volta ao antigo |
| T2 | 2 | Dois orquestradores com o mesmo `requestId` criam dois despachos distintos, sem `orch.dispatch_conflict` | `spawnExecutor.spec.ts` | conflito depois de criar nó |
| T3 | 2 | Prompt acima de 32768 bytes falha sem criar nó, ligação nem serviço | `spawnExecutor.spec.ts`, `dispatch.spec.ts` | nó e serviço criados |
| T4 | 2 | Queda simulada depois de criar a ligação: o reenvio devolve despacho `queued` e a bomba o envia | `spawnExecutor.spec.ts` | `duplicate:true` com `dispatch:null` |
| T5 | 3 | Gravação de `service_accepted` falha uma vez: o despacho termina `sent` com um único `startTurn` | `dispatchPump.spec.ts` | termina `uncertain` |
| T6 | 3 | Leitura da ligação falha depois do commit: nenhum erro em segundo plano e estado `sent` | `dispatchPump.spec.ts` | CAS estoura, erro sobe |
| T7 | 3 | Gravação falha sempre e chega `turn.started` com o `dispatchId`: o despacho vai a `sent` | `dispatchPump.spec.ts` | fica `reserved` |
| T8 | 4 | Hook aprovado com `queued` esperando: o serviço reinicia antes de qualquer envio | `hookApprovals.spec.ts`, `dispatchPump.spec.ts` | envia primeiro |
| T9 | 4 | Falha de start no reinício falha o `queued` com `not_sent`, sem chamada manual | `hookApprovals.spec.ts` | `queued` fica |
| T10 | 4 | `service.unavailable` isolado agenda a bomba | `dispatchPump.spec.ts` | não acorda |
| T11 | 5 | Boot com despacho `reserved` resolvido como concluído enfileira só o aviso `completed` | `reconcileOnBoot.spec.ts` | dois avisos |
| T12 | 5 | `failOpenDispatch` de `reserved` enfileira só `executor_down_in_turn` | `dispatchPump.spec.ts` | dois avisos |
| T13 | 6 | Falha injetada no ledger durante o aceite deixa zero despacho e zero rodada consumida | contrato do ledger, fake e SQLite | despacho `queued` sem rodada |
| T14 | 6 | Falha injetada depois da devolução não deixa despacho final sem rodada devolvida nem sem aviso | contrato do ledger | rodada ou aviso perdido |
| T15 | 7 | Runtime nulo: `orch.executor_unavailable` | `approvals.spec.ts` | `orch.approval_not_found` |
| T16 | 7 | Erro `executor.unavailable` do runtime vira `orch.executor_unavailable` em aprovação e interrupt | `approvals.spec.ts`, `dispatchToExecutor.spec.ts` | erro cru |
| T17 | 7 | Quatro decisões chegam ao runtime sem mapeamento perdido | `approvals.spec.ts` | `cancel` vira `deny` |
| T18 | 8 | Reservar com outro despacho em voo devolve nulo e não envia | `dispatchPump.spec.ts` | fake permite |
| T19 | 8 | Contrato comum passa no fake e no SQLite com os mesmos casos | helper de contrato | sem suíte comum |

#### Aceite verificável

- Etapa 1: T1 a T4, T13, T14 e T17 a T19. Etapa 2: T5 a T12, T15 e T16. Todos vermelhos antes da correção e verdes depois, com o log do vermelho no relatório da etapa.
- `pnpm exec vitest run tests/unit/contexts/orchestration tests/integration/orchestration/persistence --maxWorkers=2` verde, pasta inteira, ao fim de cada etapa.
- `pnpm arch:test`, `pnpm check` e a auditoria do harness sem arquivo do card nos resultados.
- Nenhum arquivo do card acima de 500 linhas; `OrchestrationService.ts` termina a etapa 2 com no máximo 270 linhas, para deixar folga ao F2-12 sem passar de 300.
- `DispatchInput` deixa de ter `fresh` (etapa 1); a recusa de `fresh: true` com `common.invalid_input` e a mensagem "fresh indisponível na fase 2" ficam no F2-14.
- Funções novas com complexidade ciclomática até 10; acima disso, justificativa no relatório.
- Relatório por causa raiz: teste que a prova e evidência de que as falhas do grupo sumiram.
- Revisão por qa-sonnet confere se cada correção ataca a raiz declarada.

#### Fora de escopo (depois)

- `existingSpawn` devolve ligação já fechada por `spawn_failed` como `duplicate:true`, e o `requestId` não pode ser reusado (índice único sem filtro de estado).
- `respondApproval` roda fora da exclusão do executor (`approvals.ts:22-41`).
- Desfazer o `createExecutorNode` quando o spawn falha depois de criar o nó.
- `settleBatch` sem limite de itens, `INSERT OR IGNORE` sem distinguir colisão de id (F2-05).
- Reinício limitado por tentativas no supervisor de processo (F2-11).
- Edição das declarações `errors` em `orch.ts` e recusa de `fresh` (F2-14).
- `fresh` de verdade: sessão nova no Codex troca o `threadId` e deixaria a TUI no fio antigo, o que exige relançamento e coluna `fresh` no despacho (fase 3).
- `model` nulo ao religar: a ligação não guarda o modelo, e a fase 2 religa sem ele (o Codex usa o modelo da configuração do usuário). Coluna `model` em `agent_links` na fase 3.

### F2-09b Ajustes da CLI orch

| Campo | Valor |
| --- | --- |
| Objetivo | Fechar as lacunas de texto que o F2-09 deixou: id inteiro no status e aviso de lote incerto |
| Papel | dev-backend |
| Depende de | F2-09 |
| Arquivos donos | `src/app/cli/commands/orch.ts`; `tests/unit/app/cliOrch.spec.ts`; `src/app/cli/skill/SKILL.md` (só se a skill precisar, com o limite de 250 linhas do `cliSkill.spec.ts`); `tests/unit/app/__snapshots__/cliInputOutput.spec.ts.snap` e `cliOutputBehavior.spec.ts.snap` (só se mudarem) |

Aceite verificável, depois de `pnpm build:cli`:

- `orch status` imprime o `dispatchId` inteiro em `d=`, e `orch cancel --id` aceita esse valor; o `d=` de 4 caracteres fica só no rótulo da admissão.
- Com `notices.uncertain` maior que zero, a linha traz `avisos=talvez(N)`; com zero, não traz.
- A recusa `dispatch_in_flight` continua sem "/3".
- Quando o texto for a skill, `-o json` aparece no lugar de `--json`.
- Os dois snapshots só mudam se o texto de ajuda mudar, e a mudança vai no mesmo diff.

### F2-11 Adaptador Codex

| Campo | Valor |
| --- | --- |
| Objetivo | Implementar `ExecutorRuntime` para o Codex, inclusive aprovações e confiança de hooks |
| Papel | dev-backend |
| Depende de | F2-01, F2-04, F2-06 e F2-08b (tipo `ApprovalDecision`) |
| Arquivos donos | `src/contexts/orchestration/infrastructure/codex/CodexExecutorRuntime.ts`, `CodexExecutorRuntimeFactory.ts`, `codexEventMapping.ts`, `CodexHookTrust.ts` e `CodexOrphanReaper.ts` (novo); `CodexJsonRpcClient.ts` (método `ping`) e `CodexJsonRpcClient.spec.ts`; `tests/unit/contexts/orchestration/codex/CodexExecutorRuntime.spec.ts`, `CodexHookTrust.spec.ts` e `CodexOrphanReaper.spec.ts` (novo) |

Aceite verificável, com cliente JSON-RPC falso:

- `turn/start` leva `clientUserMessageId` igual ao `dispatchId`, e a mensagem final é o último `agentMessage` do turno.
- A tabela de status do ADR está coberta, e `findTurnByDispatch` devolve `found`, `absent` e `unknown`.
- A ordem de emissão de `executor.ready`, `executor.degraded`, `executor.down` e `executor.recovered` está fixada em teste e registrada neste card, o que confirma ou corrige a suposição do mapa de saúde do ADR. Se a ordem real for outra, o card devolve a diferença ao arquiteto.
- Aprovação fica pendente até resposta ou `serverRequest/resolved`, e método desconhecido recebe -32601.
- As quatro decisões de `ApprovalDecision` saem 1 para 1 no `{decision}` do Codex (`accept`, `acceptForSession`, `decline`, `cancel`), e `cancel` também interrompe o turno.
- Um espião prova que métodos bloqueados nunca saem.
- Overrides de hook saem por chave, só para pares (`key`, `currentHash`) aprovados, em `buildCodexAppServerArgs` (`codexProcessEnv.ts`), sem mudar arquivo do F2-06. O novo `CodexHookTrust.ts` não redeclara a interface `CodexHookTrust` que já existe em `codexProcessEnv.ts`.
- `close` chama `thread/archive` antes do SIGTERM, e o encerramento por saída do app não arquiva.
- O sandbox sai de `readFullAccess: () => boolean`, injetado na fábrica e lido no start, nunca de `policy.sandbox` (que `spawnExecutor.ts:52` fixa em `null`): desligada, `workspace-write` com `on-request`; ligada, `danger-full-access` com `never`.
- Itens que o F2-06 deixou para o adaptador, cada um com teste no cliente falso: ping do ws a cada 15 s com 2 falhas virando `degraded` (`CodexJsonRpcClient.ts` não tinha `ping`), `thread/archive` antes do SIGTERM, `turn/interrupt` e identificação do órfão por pid e hash no boot (`CodexOrphanReaper.ts`, que implementa a dep opcional `reapOrphanServices` de `OrchestrationService.ts:57`).

### F2-12 Supervisor e aviso

| Campo | Valor |
| --- | --- |
| Objetivo | Transformar eventos em avisos duráveis e entregá-los agregados quando o orquestrador estiver ocioso |
| Papel | dev-backend |
| Depende de | F2-01, F2-08 e F2-08b |
| Arquivos donos | `src/contexts/orchestration/application/supervisor.ts` e `noticePump.ts`; `OrchestrationService.ts` (só o método aditivo `subscribeEvents(listener)`, que devolve cancelador e publica depois do tratamento do evento; no máximo 15 linhas, sem passar de 300), `fakes.ts` e `linkLifecycle.ts` (só se precisar); `src/contexts/orchestration/domain/noticeComposer.ts` e `noticeComposer.spec.ts` (marca "(livre)"); `src/app/main/controlSurface/orchestration/orchestratorReadiness.ts` (implementa `readReadiness` e `watchReadiness`) e `orchestratorDelivery.ts`; `src/app/main/controlSurface/ptyStream/ptyStreamHub.ts` (marca d'água de entrada); `docs/agent/PROMPT_DELIVERY.md`; `tests/unit/contexts/orchestration/application/supervisor.spec.ts` e `noticePump.spec.ts`; `tests/unit/app/ptyStreamHub.inputWatermark.spec.ts` |

Aceite verificável:

- U-06 verde.
- O `noticePump` acorda por `watchReadiness` quando o orquestrador fica ocioso, sem sondagem. `watchReadiness` assina `AgentRunStateRegistry.subscribe` filtrado por nó e estado, e devolve cancelador.
- A janela de 10 s sem digitação e a frescura do hook expiram por tempo, sem evento no registro: `watchReadiness` agenda um único temporizador para o fim da janela, sem sondagem, e o teste usa relógio falso.
- O supervisor recebe `executor.down`, `approval.requested`, `approval.resolved` e o prazo por `subscribeEvents`, sem mudança de porta.
- Aprovação sem resposta gera aviso aos 120 s, uma vez.
- Aviso repetido pela mesma chave é descartado.
- Aviso de conclusão (`completed`, `failed_turn_failed`, `interrupted`) leva a marca "(livre)" depois do `d=`, e `failed_not_sent`, `executor_down*` e `uncertain` não levam (regra da tabela "Formato e limites" do ADR de despacho), com teste em `noticeComposer.spec.ts`.
- Lote incerto fica sem reenvio e aparece no status como talvez entregue (o dado já existe em `statusView.ts:79`; o texto da CLI é do F2-09b).
- O aviso de conclusão de despacho serve de sinal de executor livre, e nenhum evento novo de disponibilidade é criado.

### F2-13 TUI do executor e nó ao lado

| Campo | Valor |
| --- | --- |
| Objetivo | Criar o nó executor ao lado do orquestrador, lançar a TUI remota nele sem grant de janela e garantir que reviver o nó passe pela orquestração |
| Papel | dev-backend |
| Depende de | F2-00 (V1 e V2) e F2-01 |
| Arquivos donos | `src/contexts/orchestration/infrastructure/codex/CodexRemoteTuiCommand.ts`; `src/app/main/controlSurface/orchestration/executorTuiLauncher.ts` e `executorNodePlacement.ts`; `src/app/main/controlSurface/handlers/sessionPrepareOrReviveTerminalAgent.ts`; `src/app/main/controlSurface/handlers/sessionPtyRuntime.ts` (só o tipo do campo explícito de `spawnSession`); `src/app/main/controlSurface/sessionGrantPtyRuntime.ts`; `tests/unit/contexts/orchestration/codex/CodexRemoteTuiCommand.spec.ts`; `tests/integration/orchestration/executorTui.spec.ts` |

Aceite verificável:

- O comando contém `resume <threadId> --remote ws://127.0.0.1:<porta> --remote-auth-token-env OPENCOVE_EXECUTOR_REMOTE_TOKEN -C <cwd>` sem `-c` de confiança da pasta e sem `CODEX_HOME` próprio na TUI (V2: o portão é do servidor) e sem o texto do token na linha.
- O ambiente da TUI carrega a variável do token, sem `OPENCOVE_CONTROL_TOKEN`, e PTY aninhado herda nenhuma das duas (I-05).
- A remoção vale só para o ambiente herdado: o lançador injeta `OPENCOVE_EXECUTOR_REMOTE_TOKEN` depois do laço de remoção de `sessionGrantPtyRuntime.ts` (que também filtra o `input.env` do chamador), por campo explícito de `spawnSession`, e roda fora de `canvasSpawnIdentity`, sem grant (A5).
- A regra de remoção de `sessionGrantPtyRuntime.ts` passa a casar `OPENCOVE_EXECUTOR_REMOTE_TOKEN` (a regex atual `OPENCOVE_(CONTROL_|NODE_ID$|...|ENV$)` não casa) e `OPENCODE_SERVER_PASSWORD`, neste card, para o OC-01 não disputar o arquivo.
- De 1 a 4 executores ficam à direita do orquestrador sem sobreposição.
- Reviver nó executor passa pelo lançador (espião) e nunca pelo lançamento comum do Codex. Se o revive exigir `sessionPrepareOrReviveTerminalSpawn.ts`, o dev para e reporta.
- O card só entrega `executorTuiLauncher.relaunch`; o relançamento da TUI no boot fica com o F2-14.

### F2-17a Contrato do resumo do pedido

| Campo | Valor |
| --- | --- |
| Objetivo | Levar o resumo do pedido de aprovação do executor até o renderer, com o campo `blockedSummary`, opcional e anulável |
| Papel | dev-frontend |
| Depende de | F2-07; abre em paralelo com F2-08b etapa 1, F2-09b e F2-13 |
| Arquivos donos | `src/shared/contracts/dto/agentRunStateSchema.ts`; `src/shared/contracts/dto/agentRunState.ts` (interface `AgentRunSnapshot`); `src/contexts/agent/domain/agentRunState.ts` (reducer); `src/app/main/controlSurface/orchestration/executorRunStateIngress.ts`; specs vizinhos desses quatro |

Hoje o resumo não chega ao renderer: `agentRunStateSchema.ts:9` só tem `blockedReason`, e `executorRunStateIngress.ts:72-76` ignora o `summary` de `approval.requested`. O ADR fixa que o alerta mostra o resumo.

Aceite verificável:

- `blockedSummary` passa pelo esquema, pela interface `AgentRunSnapshot`, pelo reducer e pelo ingresso, e estado antigo sem o campo segue válido (teste de esquema).
- O `summary` de `approval.requested` chega a `blockedSummary` enquanto a espera por `permission` durar e é limpo quando ela acaba.
- Os testes existentes de run state seguem verdes sem alteração.
- O relatório fixa o caminho do componente do cartão do AgentIsland, que o F2-17b recebe como dono.

### F2-17b Alerta de executor parado

| Campo | Valor |
| --- | --- |
| Objetivo | Chamar o usuário na hora quando um executor para numa aprovação ou fica indisponível, com repetição opcional |
| Papel | dev-frontend |
| Depende de | F2-17a (aprovado), F2-07 (espera com motivo `permission` vinda do executor) e F2-10 (loja de ligações com saúde) |
| Arquivos donos | `src/app/renderer/shell/hooks/useAgentStandbyNotificationWatcher.ts`, `useAgentStandbyNotifications.ts` (usa `notificationSoundVolume`); `src/app/renderer/shell/utils/agentAttentionRouter.ts`, `agentStandbyNotification.ts` e `sidebarAgents.ts`; `src/app/renderer/shell/store/useAgentAttentionStore.ts`; o componente do cartão do AgentIsland (caminho a fixar pelo F2-17a); `src/app/renderer/shell/AppShellOverlays.tsx` (só se o alvo do clique mudar); `src/contexts/settings/domain/notificationSettings.ts`, `notificationSettings.spec.ts`, `agentSettings.types.ts` e `agentSettings.defaults.ts`; `src/contexts/settings/presentation/renderer/settingsPanel/NotificationsSection.tsx`; `src/app/renderer/i18n/locales/en.orchestration.ts` e `zh-CN.orchestration.ts` (donos nesta onda); `docs/agent/ATTENTION.md`; `tests/unit/app/executorAttention.spec.ts` |

Aceite verificável:

- U-11 verde.
- Executor ligado em espera com motivo `permission` dispara cartão, notificação do sistema (com o app em segundo plano) e som, uma vez, com o nome do executor e o resumo do pedido (`blockedSummary`); executor `unavailable` dispara o mesmo alerta.
- O clique leva ao nó executor, que aparece como "precisa de você" na barra lateral e no espaço até a pendência acabar.
- Agente comum em espera por permissão segue sem alerta, como hoje, e as suítes atuais de atenção seguem verdes.
- A repetição nasce desligada; ligada, repete no intervalo escolhido enquanto a pendência durar e para quando ela acaba.
- Campos novos em `notificationSettings.ts` vêm com o `notificationSettings.spec.ts` atualizado.
