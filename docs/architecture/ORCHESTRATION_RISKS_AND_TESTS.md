# Riscos e testes da orquestração

Matriz de riscos e testes obrigatórios da fase 2 do [ADR da orquestração](ADR-orchestration-executor-service.md) ([adaptadores](ADR-orchestration-executor-adapters.md) e [despacho e superfície](ADR-orchestration-dispatch-and-surface.md)). Cada teste tem um id estável, citado como critério de aceite na [partição da fase 2](ORCHESTRATION_PHASE2_CARDS.md). Onde o texto diz opencode, vale a v2, que na máquina do Bruno passa a ser a única instalada, chamada como `opencode`.

## Matriz de riscos

| Id | Risco | Prob. | Impacto | Mitigação | Prova |
| --- | --- | --- | --- | --- | --- |
| R1 | O protocolo experimental do app-server muda numa versão nova do Codex | Alta | Alto | Subconjunto versionado com manifesto, versão mínima 0.167.0 e `executor.protocol_mismatch` deixando só aquele executor indisponível | C-03, C-04 |
| R2 | Despacho duplicado por nova tentativa da CLI, reinício ou modelo que repete o comando | Média | Alto | Reserva com commit antes do envio, nenhum reenvio automático, `dispatchId` idempotente (D5) e admissão por estado: um despacho em aberto por executor com índice único (D1 e D6), `admission` na resposta e no `orch status`, `dispatchId` impresso e `--id` depois de timeout | U-02, U-04, U-12, I-02, I-08, E-02, E-08 |
| R3 | Despacho perdido sem que o orquestrador saiba | Média | Alto | `reserved` vira `uncertain` no boot, reconciliação pelo serviço e aviso em todo desfecho | U-03, I-02, I-03 |
| R4 | Grant de uma janela alcança executor de outro orquestrador, ou o executor passa a despachar | Baixa | Alto | Principal só pelo grant, ligação ativa no mesmo projeto, executor sem credencial e `orch.use_dispatch` no atalho (A1 a A7) | U-09, I-01 |
| R5 | Configuração do usuário alterada em `~/.codex` ou `~/.config/opencode` | Média | Alto | Confiança só por `-c` no processo lançado, métodos de escrita de config bloqueados no cliente e hash dos arquivos conferido antes e depois | U-08, E-01, E-06 |
| R6 | Saída de um executor injeta instrução no orquestrador pelo aviso | Média | Médio | Saneamento, aspas, cabeçalho de dado, trecho de 300 grafemas e instrução da skill; o risco residual fica aceito | U-05 |
| R7 | Aviso perdido, duplicado ou entregue no meio da digitação do usuário | Média | Médio | Caixa de saída durável com chave, entrega só com o orquestrador ocioso e 10 s sem digitação, lote incerto sem reenvio | U-06, I-04 |
| R8 | Hooks do usuário ficam sem rodar no executor sem ninguém perceber | Alta | Médio | `hooks/list` no início, contagem no status e aprovação por par (`key`, `currentHash`) aplicada por chave | E-06 |
| R9 | Token do serviço vaza por linha de comando, PTY aninhado ou log | Baixa | Alto | Só o SHA-256 vai na linha, o texto fica em memória, a TUI recebe por variável e a lista de remoção cobre PTYs aninhados (A8) | U-07, I-05 |
| R10 | Serviço órfão depois da queda do Worker, ou dois app-servers disputando o mesmo `CODEX_HOME` | Média | Médio | Órfão identificado por pid e hash do token e encerrado antes de qualquer despacho `queued` ser enviado; convivência medida em V14 | I-02, I-03, F2-00 |
| R11 | O opencode v2 quebra a janela comum, ou o Glimpse chama o binário errado | Alta | Médio | Ambiente do Bruno limpo para uma v2 só, detecção por `/api/info`, `incompatible_api` sem exceção solta e executável por provedor para outros ambientes | C-05, E-05a, OC-00 |
| R12 | Custo de tokens alto por sessão nova a cada despacho | Média | Médio | Reuso de sessão por ligação, limite de 3 rodadas e de 4 executores por orquestrador | E-04 |
| R13 | O histórico do usuário em `~/.codex/sessions` fica poluído com threads do Glimpse | Baixa | Baixo | Thread nomeada "Glimpse: título do nó" e arquivada ao encerrar o executor | E-01 |
| R14 | A migração 14 quebra upgrade de instalação existente | Baixa | Alto | Matriz de upgrade instalado de 1 a 13 e reparo idempotente | C-01 |
| R15 | Executor parado em aprovação ou indisponível sem ninguém saber | Média | Alto | Alerta imediato ao usuário nos três canais, "precisa de você" até resolver, repetição opcional, aviso ao orquestrador aos 120 s e -32601 para método desconhecido | U-06, U-11, I-06, E-07 |
| R16 | Texto injetado faz o orquestrador ligar sessões sem o usuário pedir (fase 3) | Média | Alto | Pedido de conexão nasce `requested` e só vira ligação com o clique do usuário (L5) | Testes do F3-02 |
| R17 | Dois orquestradores conversando em laço gastam tokens sem parar (fase 3) | Média | Médio | Teto de 5 mensagens por lado, parada dos dois e extensão só pelo usuário (L6) | Testes do F3-05 |

Riscos aceitos sem mitigação completa:

- injeção residual pelo trecho do aviso;
- perda do turno em curso quando o Worker cai;
- Windows fora da fase 2, se V1 falhar;
- executor indisponível até a causa ser corrigida quando o Codex não sobe, porque o fallback por terminal ficou para depois;
- executor agindo fora do projeto sem pedir quando o usuário liga o acesso total;
- `model` não persistido na ligação: religar usa o modelo da configuração do usuário (coluna `model` em `agent_links` na fase 3);
- spawn falho deixa o `requestId` preso, porque o índice único não filtra o estado da ligação (item `depois` do F2-08b).

## Cenários de falha obrigatórios

Os dois cenários pedidos no plano, reinício do Worker no meio do despacho e morte do serviço, têm cada momento de corte coberto por um teste.

| Cenário | Momento do corte | Resultado esperado | Testes |
| --- | --- | --- | --- |
| Reinício do Worker | Depois do commit de `reserved` e antes da escrita no serviço | O despacho vira `uncertain` e depois `failed(not_sent)` com rodada devolvida e um aviso; o serviço recebeu zero `turn/start` | I-02 |
| Reinício do Worker | Depois da escrita e antes da resposta do serviço | O despacho vira `uncertain`, a reconciliação acha o turno pelo `dispatchId` e segue como `sent` ou `completed`; o serviço recebeu um `turn/start` só | I-02 |
| Reinício do Worker | Com o turno em curso (`sent`) | O órfão é encerrado, o serviço novo retoma a thread e o turno fecha como `completed` ou `failed(executor_down)`, com um aviso só | I-02, E-02 |
| Reinício do Worker | Durante a própria reconciliação | O segundo boot chega ao mesmo resultado, sem aviso repetido nem envio | I-02 |
| Morte do serviço | Executor ocioso | Reinício em 1 s, TUI relançada no mesmo nó com porta e token novos, um aviso de queda | I-03 |
| Morte do serviço | Durante um turno despachado | O despacho vira `uncertain`, a reconciliação depois do `executor.recovered` decide, e o aviso diz que o turno pode ter rodado em parte | I-03, E-03 |
| Morte do serviço | Quatro mortes em 60 s | Executor `unavailable`, ligação ativa, `queued` vira `failed(not_sent)` com a rodada devolvida, `uncertain` pendente vira `failed(executor_down)` e um aviso por despacho | I-03, E-03 |
| Queda do ws | Processo vivo e conexão perdida | Até 3 reconexões com o mesmo token; só depois disso vale como morte | I-03 |

## Testes de unidade

| Id | Alvo | Casos obrigatórios | Card |
| --- | --- | --- | --- |
| U-01 | Ligação | L1 a L4; executor `claude-code` recusado; nós de projetos diferentes recusados; `closed` final; religar cria linha nova | F2-01 |
| U-02 | Despacho e bomba | Um despacho em aberto por executor, `queued` incluído (D1), e a bomba reserva o único `queued`; turno vindo da tela segura o despacho `queued`; os cinco gatilhos acordam a bomba; D5 com payload igual (`duplicate: true`) e diferente (`orch.dispatch_conflict`); sem FIFO, sem janela de tempo e sem hash de conteúdo na admissão (D6); mesmo texto depois da conclusão cria despacho novo; `orch.spawn` repetido com o mesmo `requestId` devolve a ligação existente com `duplicate:true` e `dispatchId` uuid v5 igual (derivado de `orchestratorNodeId:requestId`); D7 com o quarto despacho em `orch.round_limit_reached` e recusa sem consumir rodada | F2-08 |
| U-03 | Reconciliação do boot | Cada estado em voo (`reserved`, `uncertain` e `sent`) contra cada resposta (achado em curso, achado concluído, achado com falha, ausente e `unknown`) e contra executor pronto ou `unavailable`; despacho `queued` com executor `unavailable` vira `failed(not_sent)` com rodada devolvida e aviso com `d=`; a bomba só roda depois do passo 6; chave `dispatchId:estado` impede aviso duplicado | F2-08 |
| U-04 | Máquina de estados do despacho | Toda transição da tabela do ADR; transição fora dela lança erro de domínio; estados finais (D4); texto apagado ao sair de `reserved` (D8); prazo estourado sem mudança de estado; política de rodadas; `queued` com saúde `unavailable` vira `failed(not_sent)` com rodada devolvida | F2-01 |
| U-05 | Compositor de aviso | Formato do exemplo do ADR; limites de 300 grafemas, 420 por linha, 4.000 no total e 10 linhas, com "(+1)" e "+N avisos"; saneamento de ANSI, controles, quebras e aspas duplas; emoji e acento combinado contados por grafema; trecho que imita o cabeçalho `[glimpse]` fica entre aspas | F2-01 |
| U-06 | Supervisor e entrega | Janela de 2 s com relógio falso; entrega só com run state ocioso e fresco, sem entrega em voo, sem aprovação aberta e 10 s sem digitação; recusa por ocupação mantém o lote e acorda por `watchReadiness`; travado vira `uncertain` sem reenvio; evento durante entrega vai para o lote seguinte; aviso de aprovação aos 120 s uma vez; marca d'água de entrada do PTY | F2-12 |
| U-07 | Processo do app-server | Argumentos do comando do ADR com o hash e nunca o token; ambiente sem `OPENCOVE_*`; até 3 portas novas se o bind falhar; prontidão em 10 s; encerramento com SIGTERM, 3 s e SIGKILL | F2-06 |
| U-08 | Cliente JSON-RPC | Correlação de ids; request do servidor separado de notificação; fronteira do envio (falha antes da escrita dá `rejected`, depois dela dá `send_uncertain`); -32601 para método desconhecido; até 3 reconexões com o mesmo token; métodos de escrita de config recusados antes do socket | F2-06 |
| U-09 | Autorização | Matriz do ADR para cada principal (usuário, orquestrador ligado, orquestrador sem ligação, executor e janela comum) em cada operação; `orch.not_linked` igual para nó inexistente e nó alheio (A4); `admin` fora do alcance do grant (A6); `orch.use_dispatch` (A7) para `agent.prompt` e `session.writeNode`, no teste de unidade, além do I-01 | F2-01, F2-08 |
| U-10 | Seta no canvas | Uma aresta por ligação ativa; animação com o executor trabalhando; aresta some ao fechar; nenhuma duplicação com a aresta tarefa-agente; aresta não selecionável | F2-10 |
| U-11 | Alerta de executor parado | Espera com motivo `permission` em executor ligado dispara o alerta uma vez, com nome e resumo; `unavailable` também; agente comum em espera segue sem alerta; "precisa de você" até a pendência acabar; repetição desligada por padrão e, ligada, no intervalo escolhido até a pendência acabar | F2-17 |
| U-12 | Função de admissão | `evaluateDispatchAdmission` com uma tabela de casos por linha da tabela "Admissão por estado" do ADR de despacho, na ordem de precedência: ligação `closed` e sem ligação (`orch.not_linked`), rodadas esgotadas, saúde `unavailable`, despacho `queued`, `reserved`, `sent` e `uncertain` (cada um devolve `dispatch_in_flight` com `dispatchId`, `state` e `round` do bloqueante), saúde `starting`, `degraded` e `busy` por turno da tela (aceita com `willWait`), saúde `ready` sem despacho (aceita sem `willWait`); precedência quando duas linhas valem; refinamentos de `admission` (`blocking` só com `dispatch_in_flight`, `willWait` só com `canDispatch`); a função não recebe relógio nem texto | F2-01b |

## Testes de contrato

| Id | Alvo | Casos obrigatórios | Chave | Card |
| --- | --- | --- | --- | --- |
| C-01 | Esquema 14 | Upgrade instalado de cada versão de 1 a 13; colunas novas; índices únicos parciais de L1 e D1, este último com `queued` e sob o nome `orchestration_dispatches_open_executor_unique_idx`; reparo idempotente na segunda abertura, inclusive de banco 14 com o índice antigo; `orchestration_links_revision` | Nenhuma | F2-03, F2-01b |
| C-02 | Operações `orch.*` | Esquema zod de entrada de cada operação, sem `allowRepeat` (`strictObject` recusa); escopos da matriz; códigos de erro; texto de 1 a 32.768 bytes com controles recusados; `dispatchId` uuid; esquemas de resultado de `orch.dispatch`, `orch.status` e `orch.spawn` com `admission`, `blocking`, `dispatchView` e os quatro motivos de falha, e os refinamentos do ADR; `system.operations` lista as doze | Nenhuma | F2-02, F2-02b, F2-02c |
| C-03 | Subconjunto do protocolo | Fixtures gravadas de handshake, thread, turno, lista de turnos, aprovações e `hooks/list` validam contra o subconjunto e contra o zod com campos extras aceitos; manifesto bate com hash e tamanho; subconjunto abaixo de 300 KB | Nenhuma | F2-04 |
| C-04 | Subconjunto contra o Codex instalado | `codex app-server generate-json-schema` em pasta temporária, mesmo recorte e comparação campo a campo; versão abaixo de 0.167.0 falha com mensagem clara; campo lido ausente falha com diff | `OPENCOVE_TEST_REAL_CODEX` | F2-04 |
| C-05 | API do opencode v2 instalada | `opencode serve` em porta livre com senha e `OPENCODE_CONFIG_DIR` temporário; `/api/info`, criação e leitura de sessão e abertura do SSE `/api/event`; chamada sem Basic recusada; HTML na raiz traduzido em `incompatible_api` | `OPENCOVE_TEST_REAL_OPENCODE` | OC-01 |

## Testes de integração

Rodam no vitest com SQLite real em pasta temporária, Control Surface montado em processo e grants reais do `SessionGrantRegistry`. O runtime padrão é um falso controlável, com contador de `turn/start` e ganchos de corte, e a variante com `OPENCOVE_TEST_REAL_CODEX=1` troca por `codex app-server` real contra a API de respostas falsa.

| Id | Alvo | Casos obrigatórios | Card |
| --- | --- | --- | --- |
| I-01 | Autorização com grants reais | Dois orquestradores com executores próprios: A não alcança os de B; grant de executor recebe `orch.forbidden`; grant não chama operação `admin`; `orchestratorNodeId` do payload ignorado para grant; `agent.prompt` e `session.writeNode` por grant contra executor ligado devolvem `orch.use_dispatch`, sem escrita no PTY; escrita forjada no espelho de ligações por `sync.writeState` não muda `orch.dispatch`; nó de outro projeto devolve `orch.not_linked` | F2-14 |
| I-02 | Reinício do Worker no meio do despacho | As quatro linhas de reinício da tabela de cenários, recriando a composição sobre o mesmo arquivo SQLite; na variante real, o Worker morre por SIGKILL; novo `orch.dispatch` no mesmo executor recebe `orch.dispatch_in_flight` até o fim da reconciliação, sem consumir rodada | F2-16 |
| I-03 | Morte do serviço | As quatro linhas de morte e queda do ws da tabela de cenários; recuo de 1, 2 e 4 s medido com relógio falso no runtime falso e com tolerância na variante real; com `queued` e reinícios esgotados, o despacho vira `failed(not_sent)`, a ligação fica ativa e a admissão volta a aceitar quando a saúde sai de `unavailable` | F2-16 |
| I-04 | Caixa de saída de avisos | Aviso gravado sobrevive a reinício e é entregue uma vez; chave repetida não duplica; orquestrador ocupado segura o lote; lote incerto não reenvia e aparece no status | F2-16 |
| I-05 | Ambiente da TUI e dos PTYs | TUI com `OPENCOVE_EXECUTOR_REMOTE_TOKEN` e sem `OPENCOVE_CONTROL_TOKEN`; shell aberto dentro do nó sem nenhuma das duas e sem `OPENCODE_SERVER_PASSWORD`; token ausente da linha de comando do processo e dos logs | F2-13 |
| I-06 | Aprovações | Pedido pendente sem recusa automática; resposta por `orch.approval.respond`; resolução pela tela limpa a pendência; grant de janela tentando responder recebe `orch.forbidden`; aviso aos 120 s uma vez; método desconhecido gera -32601 e `executor.degraded` | F2-16 |
| I-07 | Exclusão de nó | Apagar executor fecha a ligação com `node_deleted`, cancela o despacho `queued` com rodada devolvida, interrompe o turno e encerra o serviço em até 3 s mais SIGKILL; apagar o orquestrador fecha todas as ligações dele | F2-14 |
| I-08 | Repositório de despachos | Com SQLite real, o segundo `queued` no mesmo executor devolve `executor_busy` e não grava nada; o mesmo vale para `queued` seguido de `reserved`, `sent` e `uncertain`; executores diferentes aceitam um despacho cada; depois de `completed`, `failed` ou `cancelled` o executor aceita outro; duas inserções simultâneas gravam uma só | F2-05 |

## Testes e2e reais

Rodam pelo Playwright com CLIs reais, `CODEX_HOME` isolado e as APIs falsas de `tests/e2e/agent.prompt.real-claude.helpers.ts` e `tests/e2e/agent.prompt.real-codex.helpers.ts`, com custo de modelo zero. O roteiro do orquestrador vem da API de mensagens falsa, que responde com chamadas de shell para `opencove orch`. Só o E-04 usa modelo real.

| Chave | Liga |
| --- | --- |
| `OPENCOVE_TEST_REAL_CODEX=1` | Codex real (0.167.0 ou mais novo) em C-04, nas variantes reais de I-02 e I-03 e em E-01, E-02, E-03, E-06, E-07 e E-08 |
| `OPENCOVE_TEST_REAL_CLAUDE=1` | Claude Code real como orquestrador; sem ela, um stub de CLI faz as mesmas chamadas `opencove orch` |
| `OPENCOVE_TEST_REAL_OPENCODE=1` | opencode v2 real, pelo `opencode` do PATH, em C-05 e E-05a |
| `OPENCOVE_TEST_REAL_MODEL=1` | Modelo real no lugar das APIs falsas, só no E-04, com custo autorizado pelo Bruno em 09/11/2026 |
| `OPENCOVE_TEST_USE_REAL_AGENTS=1` | Continua ligando os e2e reais atuais e passa a valer como atalho para as chaves de Codex e Claude; nunca liga a de modelo |

| Id | Cenário | Verificação | Chaves | Card |
| --- | --- | --- | --- | --- |
| E-01 | Critério da fase | O orquestrador cria dois executores, despacha para os dois, recebe um aviso agregado com duas linhas, lê o resultado com `agent read --turn` e encerra, sem clique depois da montagem. A seta aparece e some, as threads levam o nome "Glimpse: título do nó" e saem da lista padrão depois do close, e o hash de `~/.codex/config.toml` e `~/.codex/hooks.json` do usuário sai igual | Codex e Claude | F2-16 |
| E-02 | Reinício real do Glimpse | Com o turno em curso, o app morre por SIGKILL e reabre sobre a mesma pasta de dados. O pid do órfão some, a thread é retomada, a API falsa recebeu uma requisição só para aquele turno e sai um aviso só | Codex e Claude | F2-16 |
| E-03 | Morte real do serviço | `kill -9` no app-server durante o turno: reinício, TUI relançada no mesmo nó e um aviso de queda. Com quatro mortes em 60 s, o executor fica `unavailable` e `orch status` mostra o motivo | Codex e Claude | F2-16 |
| E-04 | Custo com modelo real | Um orquestrador, dois executores e três despachos curtos, com input, cache write, cache read e output por turno e o tamanho do aviso. O segundo despacho no mesmo executor fica sem cache write de sessão nova, contra os 17,6k do achado 4, e o resultado vai para `docs/research/orchestration-phase2-cost.md` | Modelo, autorizado em 09/11/2026 | F2-16 |
| E-05a | Janela comum do opencode v2 | Nó opencode aberto com o `opencode` v2 do PATH e `OPENCODE_CONFIG_DIR` temporário: o watcher reconhece a sessão pela `/api`, sem erro de JSON, e o run state vai de trabalhando para ocioso. O turno usa provedor apontado para a API falsa, e se o OC-00 mostrar que isso não dá, o caso de turno passa a exigir a chave de modelo | opencode | OC-01 |
| E-05b | Executor opencode v2 | Fica para a fase 3, no card F3-04 | opencode | F3-04 |
| E-06 | Hooks do usuário no executor | `CODEX_HOME` isolado com um PreToolUse que grava um marcador. Sem aprovação, um turno com ferramenta não cria o marcador e o status mostra um hook aguardando. Depois de `orch.hooks.approve` e do reinício do serviço, o mesmo turno cria o marcador; hook alterado invalida a aprovação, e `config.toml` e `hooks.json` saem com o mesmo hash | Codex | F2-16 |
| E-07 | Alerta de aprovação chega até você | Com o acesso total desligado, a API falsa roteiriza um comando fora do workspace, e o Codex pede aprovação. O teste confere o cartão, a notificação do sistema com o app em segundo plano e o som, pelos registros de teste já existentes, e que o clique foca o nó executor. Depois da aprovação, o executor sai de "precisa de você" e o turno termina | Codex | F2-16 |
| E-08 | Reenvio com despacho em voo e depois de timeout da CLI | Com um despacho em voo, o segundo `orch.dispatch` recebe `orch.dispatch_in_flight` com `dispatchId`, `state` e `round` do primeiro, a CLI sai com 1 e a API falsa conta um `turn/start` só. Com timeout simulado da CLI (saída 124), três casos: o primeiro foi aceito e a resposta se perdeu, e o reenvio é recusado e o `orch status` mostra `admission` bloqueada pelo primeiro; o primeiro nunca chegou ao Worker, e o reenvio é aceito sem perda; o reenvio com `--id` do primeiro devolve `duplicate: true`. Depois de `completed`, o mesmo texto vira despacho novo e consome rodada | Codex e Claude | F2-16 |

## Comandos

```bash
pnpm build:cli
pnpm exec vitest run tests/unit/contexts/orchestration tests/unit/app/cliOrch.spec.ts
pnpm exec vitest run tests/contract/controlSurface/orch.contract.spec.ts tests/contract/orchestration tests/contract/platform
pnpm exec vitest run tests/integration/orchestration
OPENCOVE_TEST_REAL_CODEX=1 pnpm exec vitest run tests/contract/orchestration/codexProtocolInstalled.spec.ts tests/integration/orchestration
OPENCOVE_TEST_REAL_CODEX=1 OPENCOVE_TEST_REAL_CLAUDE=1 pnpm exec playwright test tests/e2e/orchestration.real-codex.spec.ts tests/e2e/orchestration.hooks.real-codex.spec.ts
OPENCOVE_TEST_REAL_OPENCODE=1 pnpm exec vitest run tests/contract/agent/opencodeV2Api.installed.spec.ts
pnpm arch:test && pnpm verify:quick
```

## Critério de pronto da fase 2

| Item | Condição |
| --- | --- |
| Unidade, contrato e integração | U-01 a U-12, C-01 a C-03 e I-01 a I-08 verdes sem chave |
| Real sem custo | C-04, as variantes reais de I-02 e I-03, E-01, E-02, E-03, E-06, E-07 e E-08 verdes com as chaves de Codex e Claude |
| Correção do opencode v2 | C-05 e E-05a verdes com a chave do opencode |
| Custo | E-04 rodado uma vez e registrado |
| Configuração do usuário | Hash de `~/.codex` e `~/.config/opencode` igual antes e depois da rodada completa na máquina do Bruno |
| Revisão | Zero achado bloqueante pelo critério fechado da partição, em revisão de agente diferente do autor |
| Portões do repositório | `pnpm arch:test` e `pnpm verify:quick` verdes |

## Pendências não bloqueantes da revisão de 09/11/2026

- Chamadas sem `requestAuth` (plugins) não têm principal definido.
- `session.stopNode`, `session.kill` e `node.delete` por grant contra executor ligado.
- A2 lê o provedor do estado gravável em vez do registro de lançamento.
- Avisos em `delivering` no boot.
- Campos que entram na comparação de payload em D5.
- F2-02 muda contrato, mas o documento de contrato é do F2-14.
- `harness/architecture/results` é gerado e compartilhado entre cards paralelos.
- Lease de 180 s do F2-07 sem fonte.
- E-01 precisa medir qual home do Codex vale.
- Corrida entre turno digitado na TUI e `turn/start`.
- Ordem de emissão de `executor.ready` e `executor.recovered` no adaptador, suposição a confirmar no F2-11.
