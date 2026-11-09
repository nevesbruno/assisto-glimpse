# Viabilidade do opencode v2 (OC-00)

Data: 09/11/2026. Script: `scripts/spikes/executor-service/viabilidade-opencode.mjs` (não versionado), executado como `node viabilidade-opencode.mjs` e, para a tentativa do V13, com `--paid`. Nenhum código de produto foi tocado.

## Pré-condição e isolamento

| Item | Evidência |
| --- | --- |
| Um só executável | `which -a opencode` devolve apenas `/home/bruno/.opencode/bin/opencode` |
| Versão | `opencode --version` devolve `opencode v2.2.6` |
| Função antiga | `whence -w opencode2` no zsh devolve `none` |
| Configuração | `OPENCODE_CONFIG_DIR` aponta para cópia temporária de `~/.config/opencode` |
| Dados | `XDG_DATA_HOME` temporário, para não gravar sessões no banco de 1,9 GB do usuário |
| Hash de `~/.config/opencode` | antes e depois `ddda122ac908ae6409972e038ff303f8a50152dde8a3ccb1b3f0f9144fb44a1b` (iguais) |
| Serviço do usuário | `opencode serve --service` com pid 3424415 antes e depois, sem ser tocado |
| Porta própria | 47901, encerrada no fim; `ps` não mostra processo remanescente |

O hash é `find . -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum`.

## Resumo

| Ponto | Veredito | Evidência |
| --- | --- | --- |
| V7 | Sim | Com `OPENCODE_SERVER_PASSWORD=senha-oc00`: sem auth 401, senha errada 401, senha da variável 200 |
| V8 | Sim | O prompt tem `id` (`msg_...`) e `metadata`; o mesmo `id` enviado duas vezes gerou uma só mensagem de usuário |
| V10 | Negativo | O raiz rejeita as três flags com `Unrecognized flag` e exit 1 |
| V11 | Sim | Sessão e as 2 mensagens voltam após reiniciar o `serve` com a mesma pasta de dados |
| V12 | Sim | `permission.asked` e `permission.replied` chegam pelo SSE de `/api/event` |
| V13 | Não testado, sem custo | Nenhum modelo pago ficou disponível no ambiente isolado; a rota falhou com custo zero |

## V7 OPENCODE_SERVER_PASSWORD

Comando: `OPENCODE_SERVER_PASSWORD=senha-oc00 opencode serve --hostname 127.0.0.1 --port 47901`, seguido de `GET /api/info` com e sem Basic `opencode:<senha>`.

Saída: `sem auth 401; senha errada 401; senha da variável 200 {"version":"2.2.6",...}`. O log do serve mostra apenas `server listening on http://127.0.0.1:47901` e não imprime senha quando a variável existe.

Veredito sim. O Glimpse gera a senha e a passa por variável, sem ler a saída do processo.

Observação: logo após o `listening`, `GET /api/info` pode devolver `503 {"code":"service_starting"}`. O cliente precisa tentar de novo até receber 200 antes de criar sessão.

## V8 campo de idempotência do prompt

Comando: `POST /api/session/{id}/prompt` duas vezes com `{id:"msg_0000000000OC00A00000000000", text:"ping", metadata:{oc00:1}}`, em sessão com modelo local inalcançável (sem custo).

Saída: as duas chamadas devolveram 200 com o mesmo `id`; a listagem tem uma só mensagem `user` com esse id. O OpenAPI declara `id` com padrão `^msg_` e `metadata` livre.

Veredito sim. O adaptador pode gerar o `id` da mensagem no despacho e reenviar sem duplicar, o que dispensa o casamento por digest do texto.

## V10 comando raiz com flags

Comandos: `opencode --hostname 127.0.0.1`, `opencode --port 1` e `opencode --model anthropic/claude-haiku-4-5`.

Saída: cada um sai com exit 1 e `ERROR  Unrecognized flag: --<flag> in command opencode`. Flags do raiz: `--standalone`, `--server`, `--auto`, `--continue`, `--session`, `--prompt`. Flags do `serve`: `--hostname`, `--port`, `--cors`, `--service`, `--stdio`.

Veredito negativo, e vale a primeira forma da correção mínima. O Worker sobe `opencode serve --hostname 127.0.0.1 --port <porta>` supervisionado, com `OPENCODE_SERVER_PASSWORD`, e a TUI entra por `opencode --server http://127.0.0.1:<porta> --session <id> <cwd>`. O modelo vai no `POST /api/session` (`model {providerID, id}`), já que `--model` não existe no raiz.

## V11 sobrevivência da sessão ao reinício

Comando: criar sessão, enviar prompt, encerrar o `serve` com SIGTERM e subir outro na mesma porta com o mesmo `XDG_DATA_HOME`.

Saída: `GET /api/session/{id}` devolve 200 com a sessão e o modelo, e `GET .../message` devolve as 2 mensagens de antes.

Veredito sim. O resume após queda do serviço reaproveita a sessão, sem aviso de custo de sessão nova.

## V12 eventos de permissão no SSE

Comando: sessão criada com `permissions: [{action:"bash", resource:"*", effect:"ask"}]`, depois `POST /api/session/{id}/permission` com `{action:"bash", resources:["ls /tmp"]}` e `POST .../permission/{requestID}/reply` com `{decision:"reject"}`.

Saída: o SSE entregou `permission.asked` com `data.id`, `sessionID`, `action` e `resources`, e depois `permission.replied`. `GET /permission` listou o pedido pendente, o reply voltou 204 e o POST de criação, que fica bloqueado até a resposta, terminou com 200.

Veredito sim, sem gastar modelo. A consulta curta a `/permission` fica como reconciliação após reconexão do SSE. Sem regra `ask` na sessão, `bash` e `edit` voltam `effect: deny` na hora e nenhum evento é emitido, então a política de permissão da sessão decide se há aprovação a mostrar.

## V13 custo da segunda sessão no mesmo diretório

Comando: duas sessões seguidas no mesmo diretório, prompt `responda apenas OK`, modelo `anthropic/claude-haiku-4-5` (cópia do `auth.json` e do `account.json` do usuário no `XDG_DATA_HOME` temporário). Repetido com `opencode/claude-haiku-4-5`.

Saída: as duas tentativas terminaram com `outcome: failed` e `provider.no-route: Model unavailable: anthropic/claude-haiku-4-5`. O `auth.json` do usuário hoje só tem `deepseek`, `alibaba`, `openai`, `opencode`, `opencode-go` e `openrouter`. O uso das sessões ficou em `cost: 0` e `cache.write: 0`.

| Sessão | Cache write | Custo |
| --- | --- | --- |
| Primeira | não medido (0 token faturado) | US$ 0 |
| Segunda | não medido (0 token faturado) | US$ 0 |

Veredito: não testado. A rodada paga autorizada não foi consumida, porque nenhum token chegou ao provedor. Ler a credencial do dado real do usuário (`~/.local/share/opencode`) foi bloqueado pelo controle de permissões, e não foi contornado. O Bruno decide se aponta um modelo disponível no `auth.json` ou se libera o uso do diretório de dados real; depois basta `OC00_PROVIDER=<provedor> OC00_MODEL=<modelo> node viabilidade-opencode.mjs --paid`.

Referência anterior, da prova de 08/11: o prompt trivial custou US$ 0,022, com cerca de 17,6 mil tokens de cache write na primeira sessão.

## Efeitos no ADR

- V7, V8, V11 e V12 passam, então os caminhos principais do adaptador valem sem o "se falhar".
- V10 negativo fixa a correção mínima na forma do `serve` supervisionado com `--server` na TUI.
- V13 segue em aberto, e a política de reuso de sessão continua como está até a medição.
