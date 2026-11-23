# Partição da fase 2: onda 6

Parte da [partição da fase 2](ORCHESTRATION_PHASE2_CARDS.md), que traz as regras de execução e a tabela de arquivos que mudam de dono. Este arquivo guarda a onda de resiliência: os defeitos de continuidade que a onda 5 encontrou, o lock do writer e os canários virados. Os ids novos entraram em [Riscos e testes](ORCHESTRATION_RISKS_AND_TESTS.md).

Em 12/11/2026 o Bruno decidiu que resiliência é identidade da orquestração do Glimpse e que estes defeitos vêm antes da fase 3. A branch `docs/orchestration-adr` segue sem PR, só com push (O25), e a thread do executor passa a se chamar `Glimpse: <título do nó>` (O26).

Estado em 12/11/2026: R1 a R4, R6 e R6b aprovados em revisão independente; R5a e R5b entregues e aprovados depois da correção da poda. As mudanças da onda ainda estão na árvore de trabalho, sem commit e sem PR.

## Decisões que valem na onda

| Decisão | Efeito |
| --- | --- |
| O25 | Não abre PR por enquanto; a branch segue só com push |
| O26 | A thread do executor é legível a humanos e leva `Glimpse: <título do nó>`, nunca o nodeId |
| Q2 | O e2e real usa o `CODEX_HOME` pessoal só para executar; nenhum agente escreve, copia ou apaga arquivo em `~/.codex` |

## Modelo de falha

| Falha | Comportamento exigido |
| --- | --- |
| App morto por SIGKILL | Reabre, reconcilia, nenhum despacho sem estado final, aviso entregue sem input |
| Worker morto por SIGKILL | Mesmo comportamento, serviço novo retoma a thread |
| Serviço do Codex morto | Reinício, um aviso de queda por morte, turno resolvido |
| Quatro mortes em 60 s | `unavailable`, um aviso por morte, motivo no `orch status`, admissão bloqueada |
| Queda do ws | Reconecta sem contar morte falsa |
| Restart com despacho em voo | Estado final correto, um `turn/start`, um aviso |
| Dependência fora no boot | Boot continua em modo degradado e tenta de novo; nunca aborta o passo |

## Invariantes e provas

| Invariante | Texto | Provas principais |
| --- | --- | --- |
| I1 | Todo despacho chega a estado final ou `uncertain` em tempo limitado | U-04, I-02, I-03, E-10, E-11 |
| I2 | Todo aviso é entregue uma vez ou marcado `uncertain`; nunca descartado em silêncio | U-06, I-04, E-10, E-11 |
| I3 | Nenhum `turn/start` duplicado para o mesmo despacho | I-02, E-08 |
| I4 | Depois do restart, o estado converge sem input do usuário em até 30 s | E-10, I-12 |
| I5 | O boot nunca aborta por executor indisponível; o serviço sobe e reconcilia depois | I-12, E-10 |
| I6 | `~/.codex/config.toml` e `hooks.json` ficam intactos | E-01, E-06, E-11 |
| I7 | Nenhum aviso exige digitação para sair depois de um crash | E-10 |

## Cards

| Card | Papel | Objetivo | Depende de | Estado e prova |
| --- | --- | --- | --- | --- |
| R1 | dev-backend | Run state pós-crash e entrega de aviso sem input | Nada | Aprovado; specs de `SessionStart`, `noticePump` e `promptDelivery`; E-10 |
| R2 | dev-backend | Boot isolado por passo, modo degradado e retry 1/3/10/30 s, com TUI relançada | Nada, junto do R1 | Aprovado; `compositionBoot.spec.ts`; I-12 |
| R3 | dev-backend | Dedupe com id monotônico de incidente | Nada | Aprovado; `supervisor.spec.ts`; E-11 |
| R4 | dev-backend | Thread com título e `orch close --to` por título ou id | Nada | Aprovado; `executorTarget.spec.ts`; E-12 |
| R5 | test-automation | Injeção de falha da matriz, flip dos canários e higiene do e2e | R1 a R4 | Aprovados depois da correção da poda; E-10, E-11 |
| R6 | dev-backend | Dono do lock do writer e fim do vazamento de app-server | R5a | Aprovado; `CodexWriterLock`, reaper e E-02 |
| R6b | dev-backend | TUI remota do Glimpse que segura o lock depois do crash | R6 e R5b | Aprovado; U-14; E-02 |

## Card R1: run state e aviso depois do crash

O orquestrador retomado deixa de ficar `unknown/degraded` até o usuário digitar. O primeiro `SessionStart` de uma invocação nova, quando a sessão existe sem fonte e com `resumeSessionId`, vira ocioso autoritativo com fronteira de fim e resultado `unknown`. O `promptAdmission` aceita `SessionStart` como fim de turno, sem inventar turno nem sobrescrever evidência.

- Arquivos donos: `src/contexts/agent/application/AgentRunStateRuntime.ts` e `promptAdmission.ts`; `src/contexts/orchestration/application/executorTuiRelaunch.ts` e `reconcileOnBoot.ts` (relançamento depois de `executor.recovered`).
- Testes: `tests/unit/app/agentRunStateSessionStart.spec.ts`, `tests/unit/app/noticePumpSessionStart.spec.ts`, `tests/unit/contexts/promptDelivery.sessionStart.spec.ts` e o caso de TUI relançada em `tests/integration/orchestration/serviceDeath.spec.ts`.
- Aceite: o aviso sai sem digitação (E-10) e o run state converge sozinho em até 30 s (I-4 e I-7).

## Card R2: boot degradado com retry

Cada passo do boot é isolado. Falha de `ready`, de reconciliação, de espelho ou de relançamento não aborta o processo: o passo é logado, a bomba abre no `finally` e o boot agenda nova tentativa em 1, 3, 10 e 30 s, repetindo o último valor enquanto a dependência faltar. Uma retentativa não substitui serviço que já subiu, e o despacho em voo é resolvido ou falha fechado antes de a tentativa terminar.

- Arquivos donos: `src/app/main/controlSurface/orchestration/composeOrchestrationBoot.ts` (constante `BOOT_RETRY_DELAYS_MS` e agendador), `reconcileOnBoot.ts` (estado parcial e `finishBoot` sempre), `composeOrchestration.ts` (fiação de `schedule`), `tests/integration/orchestration/compositionBoot.spec.ts`.
- Prova: I-12, com o caso "keeps the boot running when the reconciliation fails and retries it with backoff". O E-02 reabre o app com o passo falhando e reconcilia quando o lock é liberado, sem abortar.

## Card R3: contador monotônico de incidente

Cada morte abre um incidente com identidade própria, independente de `executor.recovered`. A chave passa a `down:<nodeId>:<uuid do supervisor>:<n>`, com `n` monotônico por executor. O sinal `restarts_exhausted` reusa a chave já aberta, então o aviso repetido é descartado pelo outbox em vez de criar um quinto aviso. O uuid do supervisor impede que um supervisor novo sobre o mesmo outbox repita as chaves de 1 em diante.

- Arquivos donos: `src/contexts/orchestration/application/supervisor.ts` e `tests/unit/contexts/orchestration/application/supervisor.spec.ts`.
- Prova: U-06 estendido, com morte antes do `recovered` e supervisor novo sobre o mesmo outbox; E-11 e I-03.

## Card R4: thread com título e close por título

O start do executor recebe o título do nó e grava `Glimpse: <título>`, com fallback para o nodeId quando o título é vazio. O `orch close --to` resolve primeiro o id exato e depois o título entre as ligações visíveis ao principal; título ambíguo devolve `orch.link_invalid` e pede o id, título de outro projeto se confunde com inexistente, e o fechamento recheca a ligação sob o slot para não fechar executor religado no meio.

- Arquivos donos: `src/contexts/orchestration/infrastructure/codex/CodexExecutorRuntime.ts`, `src/contexts/orchestration/application/spawnExecutor.ts`, `OrchestrationService.ts`, `src/contexts/orchestration/application/executorTarget.ts` (novo), `src/app/main/controlSurface/handlers/orchestrationHandlers.support.ts` e `tests/unit/contexts/orchestration/application/executorTarget.spec.ts` (novo).
- Prova: E-12. A thread retomada de antes da onda mantém o nome antigo, porque `thread/name/set` só roda na criação.

## Card R5: injeção de falha, canários e higiene

A matriz de injeção usa os rigs existentes e cobre os sete momentos do modelo de falha: app por SIGKILL (E-02), Worker por SIGKILL (I-02), serviço por SIGKILL (I-03 e E-03), queda do ws (I-03), restart com turno em voo (I-02), boot sem dependência (I-12) e as quatro mortes em 60 s (E-11). Cada correção foi removida em mutação para provar o teste vermelho.

- Canários: o E-02 perdeu `test.fail` nos dois testes e o canário da TUI do E-03 também. O E-03 four deaths passou a exigir exatamente 4 avisos, 4 chaves únicas e contadores 1..4, com a quarta morte em serviço já visto (ready-then-kill).
- Higiene: `launchRealCodexApp` exporta `UV_CACHE_DIR` e o HOME temporário aponta o cache para o real; `tests/e2e/e2e-user-data-retention.ts` (novo) poda `cove-e2e-user-data-*` antigos e preserva diretório com pid vivo ou tocado há menos de 60 s. A poda também preserva diretório cujo `SingletonLock` aponta para um pid vivo, não só o pid do marcador, caso achado na revisão e coberto por `tests/unit/e2eUserDataRetention.spec.ts`. A medição caiu de 2,7 GB em 17 diretórios para 235 MB em 6.
- Arquivos donos: `tests/e2e/e2e-user-data-retention.ts`, `workspace-canvas.testUtils.ts`, os helpers e specs real-codex, `tests/integration/orchestration/serviceDeath.spec.ts`.

## Card R6: dono do lock e vazamento de app-server

O sobrevivente do crash segura `thread-writer-locks/<thread>.lock` e o boot subia outro app-server sem fechar o anterior. A correção consulta o dono do lock, encerra apenas o app-server do projeto com token não nulo igual ao `--ws-token-sha256` gravado na ligação e o argumento exato `-c projects={...}` do cwd, e fecha toda tentativa de boot que falha antes de substituir o runtime. A identidade do serviço só é gravada depois de `ensureSession`, então `service_pid` não aponta para um processo que nunca ficou pronto.

- Arquivos donos: `src/contexts/orchestration/infrastructure/codex/CodexWriterLock.ts` (novo), `CodexOrphanReaper.ts`, `src/app/main/controlSurface/handlers/codexResumeRecovery.ts`, `src/app/main/controlSurface/orchestration/codexWriterLockRuntime.ts` (novo), `spawnExecutor.ts` e `composeOrchestration.ts`.
- Prova: U-14 parcial, `tests/unit/contexts/orchestration/codex/CodexOrphanReaper.spec.ts`, `tests/unit/app/codexResumeRecovery.spec.ts` e E-02. O órfão anterior ao R6 ficou intocado.

## Card R6b: TUI remota segurando o lock

Depois do crash, uma TUI remota do Glimpse abre a thread e segura o lock. O recovery passa a reconhecer o marcador exato `resume <thread> --remote ws://127.0.0.1:<porta> --remote-auth-token-env OPENCOVE_EXECUTOR_REMOTE_TOKEN -C <cwd>` no fim da linha, com o caminho do executável sem espaço antes de `resume`. Só então encerra o grupo, com SIGTERM, 3 s e SIGKILL. Sem marcador exato, o dono fica vivo e o boot retenta em modo degradado, fail-closed.

- Arquivos donos: `CodexWriterLock.ts` (reconhecimento da TUI), `codexResumeRecovery.ts`, `codexWriterLockRuntime.ts` e `tests/unit/app/codexResumeRecovery.spec.ts`.
- Prova: U-14. A TUI do usuário, a de outra thread, a de outro cwd (inclusive com prefixo igual), a URL não-loopback e o pid protegido ficam vivos e viram `held`.

## Segurança do R6 e do R6b

O kill só acontece quando todas as condições abaixo valem; qualquer dúvida deixa o processo vivo.

| Alvo | Condição de encerramento | O que fica vivo |
| --- | --- | --- |
| App-server | Token não nulo, igual ao hash da ligação, e argumento exato de projeto do cwd | App-server sem token, com hash diferente, de outro cwd, protegido por outra ligação ou com pid 0 e 1 |
| TUI remota | Mesma thread, mesmo cwd e marcador exato, com URL `ws://127.0.0.1:<porta>` | TUI do usuário, outra thread, outro cwd, URL não-loopback, argumento extra ou pid protegido |

O `recoverCodexWriterLock` devolve `unknown` quando o `lsof` falha, e o runtime não mata nada nesse caso. A recuperação tenta uma vez por `ensureSession` e, se o dono continuar `held`, lança `CodexWriterLockRecoveryExhaustedError` com os donos, para o boot retentar depois.

## Evidência factual

Rodada final da pasta real-codex, em 12/11/2026, com o código do R6b.

| Comando | Exit | Resultado |
| --- | --- | --- |
| `pnpm exec playwright test` na pasta real-codex completa | 0 | 9 passed, 5 skipped, 2,6 min |
| `vitest run serviceDeath compositionBoot` (R5b) | 0 | 22 passed, 1 expected fail, 1 skipped |
| `vitest run codexResumeRecovery codexWriterLockRuntime` (R6b) | 0 | 27 passed, 1 skipped |
| suíte unit e integração final do R6b | 0 | 3077 passed, 2 expected fail, 12 skipped, 1 todo |
| `pnpm check` e `pnpm arch:test` | 0 | tsc limpo; 28 testes de arquitetura |

### E-01: título e close por título

E-12. O E-01 fechou em 15,4 s. As duas threads saíram como `Glimpse: alpha` e `Glimpse: beta`, com `archived = 1` e o cwd do fixture. O orquestrador leu os dois resultados e só então chamou `orch close --to "alpha"` e `orch close --to "beta"`, sem converter título em id por `node list`. As duas ligações ficaram `closed` com motivo `orchestrator`, as arestas sumiram e o hash de `config.toml` e `hooks.json` saiu igual.

### E-02: sem input e mid-turn

E-10. Dois testes, 15,8 s e 17,2 s. O primeiro mata o app com o turno em curso e prova que o órfão some, a thread é retomada e a API falsa recebe uma requisição só para aquele turno; o aviso sai `delivered` sem digitação. O segundo é o canário de aceite, também `delivered` sem input. O app reabre sem abortar e reconcilia quando o lock é liberado; quando o lock segue preso, o boot retenta em 1, 3, 10 e 30 s. Os hashes do perfil saem iguais.

### E-03: quatro mortes

E-11. O caso de quatro mortes fechou em 17,5 s, com a morte única em 10,8 s e a TUI relançada em 7,5 s. Quatro mortes produziram 4 avisos `executor_down`, 4 chaves únicas com contadores 1..4, ligação `active`, `rounds_used = 2` de 3 e os dois despachos em voo `failed(executor_down)`, cada um com aviso `executor_down_in_turn`. Na rodada do R5b, as chaves observadas foram:

```text
down:exec-alpha:1cd07bd6-fd0e-4996-92b8-714f4c102fff:1
down:exec-alpha:1cd07bd6-fd0e-4996-92b8-714f4c102fff:2
down:exec-alpha:1cd07bd6-fd0e-4996-92b8-714f4c102fff:3
down:exec-alpha:1cd07bd6-fd0e-4996-92b8-714f4c102fff:4
```

O caso `queued` antes do watch, que vira `failed(not_sent)` com a rodada devolvida, fica na integração `serviceDeath.spec.ts`; o e2e usa ready-then-kill e prova o `executor_down` depois da quarta subida. A rodada final afirma as 4 chaves pelo formato, sem fixar o uuid. Os hashes do perfil saem iguais.

## Itens abertos

- `orch dispatch`, `orch status` e `orch interrupt` ainda resolvem só id, apesar do texto de ajuda.
- Thread antiga retomada mantém o nome velho, porque o rename só acontece na criação.
- O incidente do supervisor não é persistido; o uuid evita colisão na composição atual, mas um replay futuro de `executor.down` pode duplicar o aviso.
- Sem PR (O25); commit e push seguem com o orquestrador.

## Fechamento

- `pnpm arch:doc-sync` verde e nenhum arquivo deste fechamento acima de 500 linhas.
- R5b e R6b com revisão independente aprovada; o bloqueante da poda do R5b foi corrigido e confirmado na revisão final.
- O commit final depende do aval do Bruno e do app aberto, como na onda 5.

## Arquivos que mudam de dono dentro da onda

| Arquivo | Sequência de donos |
| --- | --- |
| `src/app/main/controlSurface/orchestration/composeOrchestration.ts` | R1 e R2 (fiação do boot), depois R6 (runtime com writer lock) |
| `src/contexts/orchestration/application/spawnExecutor.ts` | R4 (título), depois R6 (fechar tentativa que falha) |
| `src/app/main/controlSurface/handlers/codexResumeRecovery.ts` | R6, depois R6b (TUI remota) |
| `src/contexts/orchestration/infrastructure/codex/CodexWriterLock.ts` | R6, depois R6b |
| `tests/e2e/orchestration.real-codex.service.spec.ts` | R5a (canário), depois R5b (ready-then-kill e quatro mortes) |

Os demais arquivos têm um dono só na onda. Arquivo de outro card é intocável.

## Arquivos no teto de linhas

| Arquivo | Linhas | Regra |
| --- | --- | --- |
| `.../infrastructure/codex/CodexExecutorRuntime.ts` | 500 | Congelado depois do título do R4; o R6 não o edita |
| `src/app/main/controlSurface/handlers/codexResumeRecovery.ts` | 331 | R6 e R6b, só linha por linha |
| `tests/unit/app/codexResumeRecovery.spec.ts` | 461 | R6b |
| `tests/e2e/orchestration.real-codex.restart.spec.ts` | 447 | R5a |
| `tests/e2e/orchestration.real-codex.service.spec.ts` | 445 | R5a e R5b |

Medir com `wc -l`; `scripts/check-max-lines.mjs` só lê arquivo staged.
