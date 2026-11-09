# ADR da orquestração por serviço de executor

| Campo | Valor |
| --- | --- |
| Status | Proposto, com as decisões do Bruno de 09/11/2026 incorporadas |
| Data | 08/11/2026, revisado em 09/11/2026 (admissão de despacho por estado) |
| Escopo | Fases 2 e 3 do plano de orquestração (núcleo com Codex, depois opencode v2, conexão por conversa e conversa entre orquestradores) |
| Plano de origem | `~/.claude/plans/esse-projeto-um-piped-naur.md`, fora do repositório |
| Prova técnica | `scripts/spikes/executor-service/RESULTADO.md`, que o card F2-00 move para `docs/research/orchestration-spike-executor-service.md`; a pasta de spikes fica ignorada pelo git |
| Versões avaliadas | Codex CLI 0.167.0 e opencode 2.2.6 |
| Documentos irmãos | [Partição da fase 2](ORCHESTRATION_PHASE2_CARDS.md) e [Riscos e testes](ORCHESTRATION_RISKS_AND_TESTS.md) |

Neste ADR, opencode significa sempre a v2 (2.2.6). O Bruno vai deixar na máquina só a v2, no caminho padrão do instalador e chamada como `opencode`, com a configuração em `~/.config/opencode`. A v1 continua coberta só pelo código atual da janela comum e fica fora do executor.

## Contexto

O Glimpse precisa que um Claude Code orquestrador crie executores Codex e opencode, despache tarefas e receba o resultado sem consulta repetida. A POC anterior fazia isso por barramento externo, com protocolo escrito pelo próprio modelo, identidade autodeclarada e nenhuma detecção de agente morto. O plano aprovado leva o protocolo para o Glimpse e trata cada executor como serviço comandado por chamada estruturada.

O fork já tem as peças de base: credencial por janela (`SessionGrantRegistry`), Control Surface com escopos, estado de execução com arquivo de turnos (`AgentRunStateRegistry`), entrega de prompt por terminal (`PromptDeliveryService`) e SQLite com migração versionada. A prova técnica mostrou que o `codex app-server` aceita turnos por JSON-RPC enquanto a TUI com `--remote` acompanha ao vivo. O `opencode serve` da v2 fez o mesmo por HTTP e SSE.

### Achados que este ADR resolve

| # | Achado | Resposta | Seção |
| --- | --- | --- | --- |
| 1 | A TUI do Codex com `--remote` pede confiança de pasta e de hooks no lado cliente | Confiança da pasta por `-c` de tabela inline no processo do servidor (V2: a TUI não a decide); hooks resolvidos no serviço | Confiança de pasta e de hooks |
| 2 | Hooks globais do usuário aparecem `untrusted` no app-server | Fase 0 para de apagar a confiança, o serviço herda `~/.codex` e a aprovação explícita no Glimpse vira override por chave | Confiança de pasta e de hooks |
| 3 | A API do opencode v2 (`/api/*` com Basic) diverge de `OpenCodeSessionApi.ts` | Correção mínima em trilha própria, com forma decidida pela viabilidade | Correção mínima do opencode na janela comum |
| 4 | Sessão nova do opencode custa cerca de 17,6 mil tokens de cache write | Uma sessão por ligação, nova só por gatilho explícito | Reuso de sessão |
| 5 | O esquema completo do Codex tem 4,6 MB | Subconjunto versionado com manifesto e teste de contrato | Subconjunto do protocolo |
| 6 | `thread/start` com `ephemeral:false` grava em `~/.codex/sessions` | Aceito como requisito do resume, com thread nomeada | Sessão e turno do Codex |
| 7 | `opencode2` é uma função do zsh que define `OPENCODE_CONFIG_DIR=~/.config/opencode2` e executa o mesmo binário 2.2.6 de `opencode` | O Bruno limpa o ambiente para uma v2 só, com o comando `opencode`, e o Glimpse deixa de depender da função | Executável e configuração do opencode |
| 8 | A ajuda do 2.2.6 não lista `--hostname`, `--port` nem `--model` no comando raiz, e o Glimpse lança a janela comum com essas flags | Entra na correção mínima, com confirmação no card de viabilidade | Correção mínima do opencode na janela comum |

Os achados 7 e 8 vieram desta revisão, feita só com `--help` e `--version`. A prova técnica rodou o binário certo da v2, mas com a configuração da v1 (`~/.config/opencode`), o que explica o aviso do plugin `context-mode`. A API v2 é do binário, então os endpoints da prova valem para a v2 depois da limpeza.

## Decisão

1. **Contexto próprio.** Nasce o bounded context `src/contexts/orchestration/`, dono de ligações, despachos, supervisor, avisos e da porta `ExecutorRuntime`.
2. **Um serviço por executor.** Cada executor roda como processo próprio, filho do Worker e supervisionado por ele: `codex app-server` na fase 2 e `opencode serve` da v2 na fase 3.
3. **Protocolo estruturado.** O Glimpse fala com o Codex por JSON-RPC sobre WebSocket em loopback com token de capacidade, e com o opencode por HTTP com Basic e SSE. A janela do executor no canvas é uma TUI conectada ao mesmo serviço, para acompanhar e intervir.
4. **Despacho durável, idempotente e admitido por estado.** A reserva é gravada antes do envio, há no máximo um despacho em aberto por executor (`queued` incluído) e nenhum reenvio automático. O orquestrador sabe pelo estado, antes de tentar, se pode despachar. A reconciliação consulta o próprio serviço.
5. **Aviso agregado.** O Glimpse junta os eventos dos executores e entrega um aviso curto ao orquestrador pelo caminho de terminal existente, só quando ele está ocioso.
6. **Autorização pela credencial da janela.** O principal vem do grant da sessão que chama. O orquestrador só alcança executores ligados a ele, e o executor não despacha.
7. **Estado do Worker.** Ligações, despachos, avisos e aprovações de hooks vivem em tabelas próprias do Worker (esquema 14), fora do documento sincronizado que janelas conseguem gravar. O renderer recebe por leitura e evento.
8. **Configuração do usuário intocada.** Nada é gravado em `~/.codex` nem na configuração do opencode. Confiança de pasta e de hooks entra por linha de comando, só no processo lançado.
9. **Executor parado chama o usuário.** Aprovação pendente e executor indisponível disparam na hora o alerta do Glimpse (cartão, notificação do sistema e som), com repetição opcional nas configurações.
10. **Conexão por conversa, com confirmação.** Na fase 3, o usuário pede ao orquestrador "conecte com a sessão X", e X pode ser um executor ou outro orquestrador. A ligação nasce no Worker só depois de um clique do usuário no app.

### Decisões do Bruno de 09/11/2026

| Tema | Decisão |
| --- | --- |
| Aprovação de pedidos do executor | Só o usuário aprova; o modo yolo, em que o orquestrador aprova a começar pelos pedidos de leitura, fica registrado como evolução |
| Alerta de executor parado | Imediato nos três canais de atenção, com repetição configurável e desligada por padrão |
| Sandbox do executor | `workspace-write` com `on-request`; com o acesso total ligado nas configurações, o executor segue essa opção e age sem pedir |
| Thread do Codex | Arquivada ao encerrar o executor |
| Fallback por terminal | Fora da fase 2; falha do serviço gera aviso como qualquer falha |
| Limites | 3 rodadas por ligação, aviso ao orquestrador aos 120 s, 10 s sem digitação, 4 executores por orquestrador e 8 no total |
| Testes pagos | V13 e E-04 autorizados, uma rodada de cada |
| Ligações | Guardadas e autorizadas no Worker; na fase 3, também nascem por conversa, com clique do usuário. A tabela do Worker é a fonte e a única que a autorização consulta; o estado sincronizado leva só um espelho para exibição, sobrescrito pela reconciliação do Worker |
| Conversa entre orquestradores | Fase 3, com teto de 5 mensagens por lado e extensão só pelo usuário |
| opencode | Só a v2 na máquina, no caminho padrão, comando `opencode`; o Bruno faz a limpeza antes do OC-00. Aceito um `opencode serve` próprio por executor, desvio do plano aprovado |
| Pasta de spikes | Relatório em `docs/research/`, resto ignorado pelo git |
| Pedido de conexão sem resposta | Sem prazo; o pedido espera até o usuário responder |
| Commit destes documentos | Feito por agente numa branch nova, depois de revisão, em sessão futura |
| Admissão de despacho por estado | Um despacho em aberto por executor, `queued` incluído, sem fila FIFO; sem janela de tempo nem hash de conteúdo na admissão; mesmo texto depois da conclusão é despacho novo, limitado pelas 3 rodadas; correção em dois passos (`orch.cancel` ou `orch.interrupt`, depois `orch.dispatch`); a janela de 2 s e os 10 s sem digitação do aviso ficam. A recusa `orch.dispatch_in_flight` é só rede de segurança |

## Alternativas descartadas

| Alternativa | Motivo do descarte |
| --- | --- |
| Barramento externo com protocolo no prompt (POC hcom) | Identidade autodeclarada, consulta em laço, mensagens de protocolo escritas pelo modelo e nenhuma detecção de morte |
| Só terminal, com `agent prompt` para tudo | Sem correlação exata de turno nem idempotência verificável; o fallback por terminal fica como evolução futura |
| Um app-server compartilhado por todos os executores | Falha, reinício e confiança compartilhados, e uma queda derruba todos |
| Reaproveitar o daemon do usuário (`app-server-control`) ou o `opencode serve --service` | São processos e configuração do usuário, fora do controle do Glimpse |
| Ligações no estado sincronizado (`sync.writeState`) como fonte de autorização | `sync.writeState` tem escopo interact, então qualquer janela com credencial poderia forjar uma ligação e ganhar alcance de despacho. O espelho só para exibição é aceito (seção Sincronização com o renderer) |
| Vista própria do Glimpse desenhada por eventos | Mais interface, e a prova mostrou que a TUI remota acompanha; fica como plano B |
| Gravar confiança em `~/.codex`, por `config/value/write` ou respondendo o portão da TUI | Altera configuração do usuário, critério de reprovação do plano |
| Stdio como transporte do app-server | Aceita um cliente só, e a TUI precisa do mesmo servidor |
| Injetar despacho em turno ativo com `turn/steer` | Muda o turno em curso sem fronteira clara; o despacho espera ociosidade |
| Reanexar ao serviço órfão depois de queda do Worker | Exigiria guardar o token de capacidade em disco |
| Ligação criada direto pelo orquestrador, sem confirmação | O Glimpse não distingue o pedido do usuário de um texto injetado pela saída de outro agente |
| Fila FIFO de profundidade livre por executor, com deduplicação por conteúdo em 10 min (D6 anterior) | Heurística de tempo e de texto que barra reenvio legítimo e deixa passar o reformulado; o orquestrador não ficava sabendo pelo estado quando podia despachar |

## Consequências

| Consequência | Efeito | Tratamento |
| --- | --- | --- |
| Protocolo fora do modelo | O custo do orquestrador por ciclo cai para um comando, um aviso e uma leitura opcional | Medido no e2e E-04 |
| Queda e duplicação tratáveis | O serviço informa se o turno existe, então reconciliar vira consulta direta | Reconciliação no boot e depois de cada reinício |
| Dependência de protocolo experimental | Cada atualização do Codex pode exigir ajuste no adaptador | Subconjunto versionado, teste de contrato e versão mínima |
| Um processo a mais por executor | Memória e portas crescem com o número de executores | Limite de 4 por orquestrador e 8 no total, memória medida na viabilidade |
| Threads persistentes do Codex | O histórico do usuário em `~/.codex/sessions` ganha threads do Glimpse | Thread nomeada e arquivada ao encerrar o executor, recuperável por `thread/unarchive` |
| Executor parado espera alguém | Pedido de aprovação segura o turno até o usuário agir | Alerta imediato ao usuário e aviso ao orquestrador aos 120 s |
| O aviso continua sendo texto colado | Cada aviso consome um turno do orquestrador | Agregação por ociosidade e teto de 4.000 caracteres |
| Mais estado no Worker | Quatro tabelas novas e migração 14 | Migração aditiva, fixture v13 e downgrade best-effort |
| Turno em voo se perde quando o Worker cai | O trabalho em curso é interrompido, sem duplicar despacho | Aviso de falha ao orquestrador, que decide redespachar |
| A janela comum do opencode depende de correção própria | O 2.2.6 mudou API e flags do comando raiz | Trilha OC, separada da fase 2 |
| Um despacho em aberto por executor | O orquestrador não empilha trabalho: para despachar de novo precisa do aviso, de `orch.cancel` ou de `orch.interrupt` | `admission` na resposta e no `orch status`, texto da skill e recusa `orch.dispatch_in_flight` com o bloqueante |

## Documentos do ADR

| Seção | Arquivo |
| --- | --- |
| Adaptador Codex app-server | [Adaptadores e ciclo de vida do executor](ADR-orchestration-executor-adapters.md) |
| Adaptador opencode v2 | [Adaptadores e ciclo de vida do executor](ADR-orchestration-executor-adapters.md) |
| Correção mínima do opencode na janela comum | [Adaptadores e ciclo de vida do executor](ADR-orchestration-executor-adapters.md) |
| Fallback por terminal como evolução | [Adaptadores e ciclo de vida do executor](ADR-orchestration-executor-adapters.md) |
| Ciclo de vida do serviço por executor | [Adaptadores e ciclo de vida do executor](ADR-orchestration-executor-adapters.md) |
| Ligações e fila de despacho (inclui Admissão por estado e Saúde do executor no DTO) | [Despacho, aviso, autorização e superfície da orquestração](ADR-orchestration-dispatch-and-surface.md) |
| Supervisor e aviso agregado | [Despacho, aviso, autorização e superfície da orquestração](ADR-orchestration-dispatch-and-surface.md) |
| Autorização pela credencial da janela | [Despacho, aviso, autorização e superfície da orquestração](ADR-orchestration-dispatch-and-surface.md) |
| Operações do Control Surface (inclui Resultados de orch.dispatch, orch.status e orch.spawn) | [Despacho, aviso, autorização e superfície da orquestração](ADR-orchestration-dispatch-and-surface.md) |
| Comandos orch | [Despacho, aviso, autorização e superfície da orquestração](ADR-orchestration-dispatch-and-surface.md) |
| Migração SQLite 13 para 14 | [Despacho, aviso, autorização e superfície da orquestração](ADR-orchestration-dispatch-and-surface.md) |
| Sincronização com o renderer | [Despacho, aviso, autorização e superfície da orquestração](ADR-orchestration-dispatch-and-surface.md) |
| Seta no canvas e ligação manual | [Despacho, aviso, autorização e superfície da orquestração](ADR-orchestration-dispatch-and-surface.md) |

## Contexto de orquestração e suas camadas

O contexto segue o mesmo DDD com Clean dos demais. As regras de `harness/architecture/rules.json` impedem a infraestrutura de importar `src/app/main`. Por isso reserva de porta, criação de nó, lançamento da TUI e entrega ao orquestrador entram como portas, implementadas na composição.

| Camada | Pasta | Conteúdo | Depende de |
| --- | --- | --- | --- |
| Domínio | `src/contexts/orchestration/domain/` | `agentLink.ts` (ligação e invariantes), `dispatch.ts` (máquina de estados pura), `dispatchAdmission.ts` (admissão por estado), `roundPolicy.ts`, `noticeComposer.ts` (agregação, saneamento e corte), `orchestrationAuthorization.ts` (matriz de principal) | `shared` |
| Aplicação | `src/contexts/orchestration/application/` | `ports/`, casos de uso, `dispatchPump.ts`, `reconcileOnBoot.ts`, `executorHealth.ts`, `supervisor.ts`, `noticePump.ts` e a fachada `OrchestrationService.ts` | domínio e `shared` |
| Infraestrutura | `src/contexts/orchestration/infrastructure/` | `codex/` (processo, cliente JSON-RPC, adaptador, comando da TUI, confiança de hooks e `protocol/`), `opencode/` (fase 3) e `persistence/` | aplicação, domínio, `platform` e `shared` |
| Renderer | `src/contexts/orchestration/presentation/renderer/` | `useOrchestrationLinks.ts` e a loja de ligações | aplicação, domínio e `shared` |
| Composição e handlers | `src/app/main/controlSurface/orchestration/` e `src/app/main/controlSurface/handlers/orchestrationHandlers.ts` | Implementação das portas que dependem do app, handlers `orch.*` e registro em `registerControlSurfaceHandlers.ts` | tudo, menos renderer |
| Contratos | `src/shared/contracts/controlSurface/operations/domains/orch.ts` e `src/shared/contracts/dto/orchestration.ts` | Entradas zod, normalize puro, DTOs, resultados e erros | `shared` |
| CLI | `src/app/cli/commands/orch.ts` | Grupo `orch` | `shared` |

| Porta | Responsabilidade | Implementação |
| --- | --- | --- |
| `ExecutorRuntimeFactory` e `ExecutorRuntime` | Falar com o serviço do executor | `infrastructure/codex` e, na fase 3, `opencode` |
| `AgentLinkRepository`, `DispatchRepository`, `NoticeOutboxRepository` e `HookApprovalRepository` | Persistência com CAS por `revision`; `DispatchRepository` busca o despacho fora de estado final do executor e recusa o segundo com `executor_busy` | `infrastructure/persistence` |
| `ExecutorNodePort` | Criar o nó ao lado do orquestrador e ler provedor e existência de nós | Composição, sobre o fluxo de `node.create` |
| `ExecutorTuiLauncher` | Lançar e relançar a TUI no PTY do nó | Composição, sobre o caminho de lançamento de sessão |
| `OrchestratorDeliveryPort` | Entregar o aviso ao orquestrador | Composição, sobre `PromptDeliveryService` |
| `OrchestratorReadinessPort` | Dizer se o orquestrador está ocioso (`readReadiness`) e avisar quando ele fica ocioso (`watchReadiness`) | Composição, sobre run state, `AgentRunStateRegistry.subscribe` e marca d'água de entrada do `ptyStreamHub` |
| `ExecutorRunStateIngress` | Alimentar o run state e o arquivo de turnos | Composição, sobre `AgentRunStateRegistry` |
| `PortReserver` | Reservar porta de loopback | Composição, sobre `reserveLoopbackPort` |
| `OrchestrationEventPublisher` | Publicar `orchestration.links.updated` | Composição, sobre `publishSyncEvent` |
| `Clock` e `IdGenerator` | Tempo e ids testáveis | Composição |

`OrchestrationService` serializa as operações de cada executor com exclusão mútua em memória, o que basta porque o Worker é processo único. A durabilidade fica no SQLite, com CAS por `revision` e índices únicos parciais. Assim as invariantes centrais seguram mesmo diante de defeito na aplicação.

## Porta ExecutorRuntime

A porta esconde o provedor. O caso de uso só conhece sessão, turno, aprovação e saúde, e cada adaptador traduz para o protocolo do seu serviço.

### Operações

| Operação | Entrada | Saída | Garantia |
| --- | --- | --- | --- |
| `factory.probe()` | nenhuma | Executável resolvido, versão e compatibilidade | Sem efeito colateral |
| `factory.start(spec)` | Nó executor, cwd, ambiente do provedor, `sessionRef` opcional, modelo e política | `ExecutorRuntime` pronto | Sobe o processo e espera prontidão |
| `ensureSession({ resumeRef, fresh })` | Referência de sessão | `{ sessionRef, resumed }` | Retoma quando possível; sessão nova só com `fresh` ou perda |
| `startTurn({ dispatchId, text })` | Despacho já gravado como `reserved` | `{ turnRef }` | Uma escrita no transporte por chamada, nunca repetida |
| `findTurnByDispatch(dispatchId, since)` | Id do despacho e horário da reserva | `found` com `turnRef`, status e mensagem final, ou `absent`, ou `unknown` | Só leitura |
| `readTurn(turnRef)` | Turno | Status, mensagem final e uso | Só leitura |
| `respondApproval(requestId, decision)` | Pedido e decisão | ok ou `approval_not_found` | Idempotente por `requestId` |
| `interrupt(turnRef?)` | Turno opcional | ok | Sem efeito com executor ocioso |
| `attachInfo()` | nenhuma | URL, nome da variável do token, `sessionRef` e cwd | Insumo do lançamento da TUI |
| `subscribe(listener)` | Ouvinte | Cancelador | Eventos em ordem por executor |
| `close(reason)` | Motivo | ok | SIGTERM, espera de 3 s e SIGKILL |

### Eventos

| Evento | Campos | Uso |
| --- | --- | --- |
| `executor.ready` | `sessionRef`, `resumed`, `version` | Libera o despacho `queued`; entra no `health` |
| `turn.started` | `turnRef`, `dispatchId?`, `origin` (`glimpse` ou `screen`) | Run state em trabalho; turno vindo da tela segura o despacho `queued`; `health` vira `busy` |
| `turn.completed` | `turnRef`, `dispatchId?`, `outcome` (`completed`, `failed` ou `interrupted`), `finalMessage?`, `usage?` | Fecha o despacho e gera aviso |
| `approval.requested` | `requestId`, `kind`, resumo e `turnRef` | Interface primeiro e prazo de escalonamento |
| `approval.resolved` | `requestId`, `resolvedBy` (`screen` ou `glimpse`) | Cancela o prazo |
| `hooks.trust_pending` | Lista de `key`, evento, origem e `currentHash` | Status e interface |
| `executor.degraded` | Motivo | Aviso na interface; `health` vira `degraded` |
| `executor.down` | Motivo, código de saída e sinal | Despacho em voo vira `uncertain` e o supervisor reinicia; `health` vira `starting` ou `unavailable` |
| `executor.recovered` | `sessionRef` | Dispara a reconciliação; `health` vira `starting` até o fim dela |

O mapeamento completo dos eventos para o `health` do DTO está em "Saúde do executor no DTO", no ADR de despacho. A ordem de emissão de `executor.ready` e `executor.recovered` no Codex é suposição a confirmar no F2-11.

### Erros

| Código | Quando | Efeito no despacho |
| --- | --- | --- |
| `executor.start_failed` | Spawn, bind ou prontidão falharam depois de 3 tentativas | O despacho fica `queued` até os reinícios se esgotarem e então vira `failed(not_sent)` com aviso |
| `executor.unavailable` | Processo fora do ar ou reiniciando | O despacho `queued` espera; a admissão aceita um novo só quando não há outro em aberto |
| `executor.busy` | Turno em curso | O despacho `queued` espera; o pedido nem chega ao serviço |
| `executor.rejected` | O serviço recusou `turn/start` antes de aceitar | `failed(not_sent)` com rodada devolvida |
| `executor.send_uncertain` | Conexão caiu ou prazo esgotou depois da escrita e antes da resposta | `uncertain` |
| `executor.session_lost` | Resume falhou | Sessão nova só pela política de reuso, com aviso |
| `executor.protocol_mismatch` | Versão ou formato fora do subconjunto validado | Executor indisponível e aviso com a versão encontrada |
| `executor.unsupported` | Operação sem suporte no modo, como `findTurnByDispatch` exato no terminal | `unknown` na reconciliação |

A fronteira do envio é a escrita do pedido no transporte. Falha antes da escrita, ou resposta de erro do serviço, é `rejected`. Qualquer falha depois da escrita, sem resposta, é `send_uncertain`.

## Pontos condicionados à viabilidade

| Ponto | Pergunta | Se falhar | Resultado (09/11/2026) |
| --- | --- | --- | --- |
| V1 | O token de capacidade funciona com `--remote-auth-token-env` na TUI e com cabeçalho no cliente `ws`? | Socket unix com permissão 0600 em POSIX; Windows adiado | Sim: Bearer e `--remote-auth-token-env` funcionam; `/readyz` aberto sem auth |
| V2 | `codex resume --remote` aceita `-c projects."<cwd>".trust_level`, e a confiança no cliente deixa o servidor igual? | `CODEX_HOME` temporário só da TUI, com configuração mínima e nada em `~/.codex` | Negativo: portão decidido pelo servidor; vale a tabela inline `projects={...}` no `app-server`; forma pontilhada não funciona |
| V3 | O override por chave em `hooks.state` funciona, e a tabela inteira substitui ou mescla? | Aprovação só pela confiança dada no próprio Codex | Parcial: só a tabela inline `hooks.state={...}`; pontilhada ignorada; mescla com o `config.toml` |
| V4 | `clientUserMessageId` volta em `userMessage.clientId`? | Casamento por `turnRef`; sem resposta, `uncertain` | Sim |
| V5 | Com dois clientes, quem recebe os requests de aprovação? | Se só a TUI receber, aprovação só pela tela, com o Glimpse observando por notificação | Sim: os dois clientes recebem o request; o primeiro a responder fecha |
| V6 | Qual o status de turno em curso depois de queda, e `thread/turns/list` funciona após reinício? | Turno sumido vira `failed(executor_down)` com aviso | Sim: o turno volta `interrupted`, localizado por `clientId`, mapeado para `failed(executor_down)` |
| V7 | `opencode serve` respeita `OPENCODE_SERVER_PASSWORD`? | Senha lida da saída | Sim, com 503 `service_starting` logo após subir |
| V8 | O prompt do opencode tem campo de idempotência? | Casamento por digest e horário | Sim: `id` (`^msg_`) idempotente; reconciliação por esse id |
| V9 | Pid e hash do token identificam o órfão com segurança? | Grupo de processos e encerramento do grupo no boot | Sim: SIGTERM não encerra com turno em voo; SIGKILL no grupo após o prazo |
| V10 | Como o raiz do opencode 2.2.6 reage a `--hostname`, `--port` e `--model`? | Decide a forma da correção mínima | Negativo: o raiz rejeita as flags; `serve` separado e TUI com `--server` |
| V11 | A sessão do opencode sobrevive ao reinício do `serve`? | Sessão nova, com aviso de custo | Sim |
| V12 | Os eventos de permissão chegam pelo SSE do opencode? | Consulta curta a `/permission` durante o turno | Sim, por SSE (`permission.asked` e `permission.replied`) |
| V13 | Quanto custa uma segunda sessão no mesmo diretório dentro do TTL? | Ajuste da política de reuso | Medido com deepseek/deepseek-flash: US$ 0,00132 na primeira sessão e US$ 0,00006 na segunda (cerca de 20 vezes menos, cache automático); a política de uma sessão por ligação continua |
| V14 | Dois app-servers sobre o mesmo `CODEX_HOME` convivem sem corromper estado? | Serialização do início e alerta de integridade | Parcial: partida simultânea em home vazio falha, então serializar; resume da mesma thread em dois servidores é recusado |
| M1 | Quanta memória usa um app-server ocioso e em turno? | Ajuste dos limites de executores | Sim: 92 a 119 MiB ocioso, 156 a 188 MiB em turno |

## Referências

- Plano: `~/.claude/plans/esse-projeto-um-piped-naur.md`.
- Prova: `scripts/spikes/executor-service/RESULTADO.md` (depois do F2-00, `docs/research/orchestration-spike-executor-service.md`), `codex-spike.mjs` e `opencode-spike.mjs`.
- POC: `~/lab/opencove-hcom-orchestrator/src/protocol/state-machine.mjs`, `src/storage/protocol-store.mjs` e `src/view/agent-status.mjs`.
- Código atual: `CodexHookTrustResolver.ts`, `CodexAgentProviderContribution.ts`, `OpenCodeSessionApi.ts`, `OpenCodeSessionStateWatcher.ts`, `AgentCommandFactory.ts`, `sessionGrantRegistry.ts`, `sessionGrantPtyRuntime.ts`, `agentPromptHandlers.ts`, `AgentRunStateRegistry.ts`, `PromptDeliveryService.ts` e `useTaskAgentEdges.ts`.
- Documentos: `docs/architecture/CONTROL_SURFACE.md`, `docs/architecture/PERSISTENCE.md`, `docs/agent/PROMPT_DELIVERY.md` e `docs/agent/RUN_STATE.md`.
