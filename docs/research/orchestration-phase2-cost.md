# Custo da orquestração com modelo real (E-04)

Medição de 12/11/2026, autorizada pelo Bruno em 09/11/2026 e executada uma única vez. Repo na base `a73dffbd` (branch `docs/orchestration-adr`), Codex `0.167.1`, modelo `gpt-6.1-terra` do perfil pessoal (`CODEX_HOME` padrão, decisão Q2), provedor `openai`. O consumo saiu do plano ChatGPT do Bruno; a estimativa em dólar usa o preço de API equivalente.

## Método

O cenário tem um orquestrador, dois executores e três despachos curtos: `alpha` recebe dois despachos e `beta` um. O orquestrador é o Claude Code real com a API de mensagens falsa, então o roteiro de comandos `opencove orch` é o mesmo de produção e o custo dele é zero. Só os dois executores usam o modelo real. Essa escolha está justificada porque o custo que o E-04 mede é o dos executores; usar modelo real também no orquestrador somaria custo sem responder à pergunta do card.

Os executores rodam pelo `codex app-server` real. O wrapper do teste apenas executa o binário `codex` do PATH, sem `-c` de provedor. A sessão é reutilizada por ligação: `alpha` mantém a mesma thread nos dois despachos, `beta` usa outra thread.

Fonte de verdade dos tokens: os eventos `token_usage_record` da sessão JSONL do Codex, lidos de `~/.codex/archived_sessions` (a thread é arquivada no `orch close`) e de `~/.codex/sessions`. Cada evento traz `turn_token_usage` com `input_tokens`, `cached_input_tokens`, `cache_write_input_tokens` e `output_tokens`. O harness do teste não escreve em `~/.codex`; o runtime do Codex grava os rollouts das sessões, `state_5.sqlite` e `memories_1.sqlite`. `config.toml` e `hooks.json` ficam intactos, com hash igual antes e depois.

O Codex reportou `cache_write_input_tokens = 0` nos três turnos, porque o provedor não devolve a escrita explícita. Por isso a coluna "cache write" da tabela é derivada: `input - cache read`. É a parte do prompt que entrou nova no cache naquele turno.

## Tokens por turno

| Despacho | Executor | Rodada | Input | Cache write (derivado) | Cache read | Output | Reasoning | Requisições |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `E04_ALPHA_1` | alpha | 1/3 | 32.926 | 25.758 | 7.168 | 5 | 0 | 1 |
| `E04_ALPHA_2` | alpha | 2/3 | 32.971 | 203 | 32.768 | 5 | 0 | 1 |
| `E04_BETA_1` | beta | 1/3 | 32.927 | 25.759 | 7.168 | 5 | 0 | 1 |

O primeiro turno de cada executor leu 7.168 tokens de um prefixo que já estava em cache (sistema e ferramentas compartilhados com sessões anteriores do Codex) e escreveu cerca de 25,8 mil tokens novos. O segundo turno de `alpha` leu 32.768 dos 32.971 de input, acerto de 99,38%, e só 203 tokens ficaram fora do cache.

## Comparação com o achado 4

| Medida | Tokens | Leitura |
| --- | ---: | --- |
| Cache write de sessão nova no primeiro despacho (alpha) | 25.758 | 1,46 vez o baseline de 17,6 mil |
| Cache write de sessão nova no primeiro despacho (beta) | 25.759 | mesmo patamar |
| Baseline do achado 4 | 17.600 | referência da prova de 08/11, com o system prompt do opencode |
| Cache write do segundo despacho em `alpha` | 203 | sem sessão nova, só o texto novo |
| Cache read do segundo despacho em `alpha` | 32.768 | 99,38% do input |
| Segundo despacho contra o baseline | 1,15% | 203 contra 17.600 |

O segundo despacho no mesmo executor não pagou cache write de sessão nova. Ele ficou em 203 tokens, 1,15% dos 17,6 mil do achado 4. A sessão nova do Codex custa mais caro que o baseline do opencode (25,8 mil contra 17,6 mil), mas esse custo aparece uma vez por ligação, não a cada despacho.

## Tamanho do aviso

| Aviso | Conteúdo | Caracteres | Bytes | Linhas |
| --- | --- | ---: | ---: | ---: |
| 1 | alpha concluiu a rodada 1 | 227 | 229 | 1 |
| 2 | beta concluiu a rodada 1 | 225 | 227 | 1 |
| 3 | alpha concluiu a rodada 2 | 227 | 229 | 1 |
| Total | 3 avisos | 679 | 685 | 3 |

Cada aviso é uma linha de executor com o cabeçalho `[glimpse]`, o resultado `"OK"` e a instrução `ler: opencove agent read --node ... --turn ...`. O custo do orquestrador com esses avisos é zero nesta medição, porque a API de mensagens é falsa.

## Estimativa de custo

Preço usado, tabela padrão da API do `gpt-6.1-terra` em 27/10/2026: input US$ 1,00 por milhão, cache read US$ 0,05 por milhão, cache write de 30 minutos US$ 1,25 por milhão e output US$ 5,00 por milhão. Como o Bruno usa o plano ChatGPT, o valor abaixo é equivalente de API, não uma fatura por token.

| Item | Tokens | Preço por milhão | Custo |
| --- | ---: | ---: | ---: |
| Cache write derivado | 51.720 | US$ 1,25 | US$ 0,064650 |
| Cache read | 47.104 | US$ 0,05 | US$ 0,002355 |
| Output | 15 | US$ 5,00 | US$ 0,000075 |
| Total dos três despachos | | | US$ 0,067080 |

Por turno: `alpha` r1 US$ 0,032581, `alpha` r2 US$ 0,001917 (17 vezes mais barato que o primeiro) e `beta` r1 US$ 0,032582. Sem cache, os mesmos 98.824 tokens de input e 15 de output custariam US$ 0,098899; o cache reduziu a estimativa em 32%. Se o provedor cobrar a escrita de cache além da entrada comum, o teto da estimativa sobe para US$ 0,118800.

## Evidência

- Log do run real: `/tmp/opencode/glimpse-onda5/logs/f216c2/real-r1.log`, exit 0, 1 teste passou em 20,2 s. A linha `E04_COST_REPORT` do log traz o JSON completo usado nas tabelas.
- Hash do perfil: `/tmp/opencode/glimpse-onda5/logs/f216c2/profile-before.txt`, conferido com `sha256sum -c` antes e depois, sem diferença.
- Ensaios fake: `fake-r1.log` a `fake-r4.log`; dois vermelhos de harness (assinatura do Playwright e rollout arquivado) e dois verdes com os valores determinísticos 18.000 para escrita e 0 para o segundo despacho.
- Spec: `tests/e2e/orchestration.cost.real-model.spec.ts`; helpers `orchestration.cost.real-model.helpers.ts`, `.orchestrator.ts` e `.tokens.ts`.
- Comando do run real: `OPENCOVE_TEST_REAL_CODEX=1 OPENCOVE_TEST_REAL_MODEL=1 pnpm exec playwright test tests/e2e/orchestration.cost.real-model.spec.ts --grep "real model cost" --workers=1`, sob `flock`, `nice`, `ionice` e `xvfb-run`.

## Limitações

O baseline de 17,6 mil vem de outra prova, com o system prompt do opencode e tokenizador diferente, então a razão 1,46 não compara o mesmo prompt. A leitura correta do E-04 é a segunda linha: o segundo despacho não paga sessão nova. O primeiro turno já leu 7.168 tokens de cache do prefixo compartilhado, o que reduz a escrita nova mas não a elimina. O `cache_write_input_tokens` do Codex veio zero nos três turnos, então a escrita é derivada do input não lido do cache; se o provedor passar a reportar o campo, a tabela deve ser refeita com o valor explícito.
