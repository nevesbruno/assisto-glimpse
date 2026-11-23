# Viabilidade do Codex app-server para o serviço de executor

Card F2-00. Data: 2026-11-09. Codex 0.167.0, Node 22.23.2, Linux.

## Método

Todo ponto roda com `CODEX_HOME` temporário, servidores próprios em portas livres e a API de respostas falsa de `tests/e2e/agent.prompt.real-codex.helpers.ts`. O custo de modelo é zero, e nenhum ponto exigiu modelo real. O daemon do Codex do usuário e o `~/.codex` não foram tocados.

O script é `scripts/spikes/executor-service/viabilidade-codex.mjs` (ignorado pelo git), e `--only=V1,V4` roda pontos isolados. A TUI roda sob `script -qfec` com pseudo-terminal, e a tela é lida por texto. Cada servidor sobe em grupo de processos próprio, e o script encerra só o que subiu.

Integridade de `~/.codex`, medida com `sha256sum` antes e depois da execução completa:

| Arquivo | sha256 antes | sha256 depois |
| --- | --- | --- |
| `~/.codex/config.toml` | `dc73554ade6d750c26257648e47dbbedc39a9cd6192d1f2f091fabc36f7e4cb4` | igual |
| `~/.codex/hooks.json` | `1b5864cd9711fb9daa4eef0ca54a62db36dc7c309f9583bc7699ce02b7680562` | igual |

## Resumo

| Ponto | Veredito | Consequência para o ADR |
| --- | --- | --- |
| V1 token de capacidade | sim | Nenhuma |
| V2 confiança de pasta na TUI | negativo | O gate é decidido pelo servidor. Trocar o `-c` da TUI por override de tabela inline no servidor |
| V3 override de hooks | parcial | A forma pontilhada é ignorada. A tabela inline funciona e mescla |
| V4 eco do `clientId` | sim | Nenhuma |
| V5 dois clientes e aprovação | sim | Todos os clientes inscritos recebem o request |
| V6 queda e reinício | sim | O turno em voo volta `interrupted`, não `inProgress` |
| V9 órfão por pid e hash | sim | Nenhuma |
| V14 dois servidores, mesmo `CODEX_HOME` | parcial | Partida simultânea em home novo falha. Serializar o início |
| M1 memória | sim | 92 a 119 MiB ocioso, 156 a 188 MiB com turno |

V1, V4 e V5 deram sim, então a onda 3 não volta ao arquiteto por esses três pontos. V2 deu negativo e exige ajuste de texto no ADR, sem mudar a arquitetura.

## V1 Token de capacidade

Comando: `codex app-server --listen ws://127.0.0.1:<porta> --ws-auth capability-token --ws-token-sha256 <sha>`, cliente `ws` com `{headers:{Authorization:'Bearer <token>'}}` e TUI com `codex resume <id> --remote ws://... --remote-auth-token-env VIAB_TOKEN`.

| Verificação | Saída observada |
| --- | --- |
| Cliente com Bearer correto | conectou, `initialize` ok |
| Sem token e token errado | `HTTP 401` nos dois |
| Token só em query string | `Unexpected server response: 401` |
| `/readyz` sem token | `200` |
| Linha de comando do processo | contém o sha256, não contém o token |
| TUI com a variável correta | mostra o histórico da thread (`ACK`) |
| TUI com token errado | `failed to connect to remote app server ... HTTP error: 401 Unauthorized` |

Veredito: sim. O formato do cabeçalho é `Authorization: Bearer <token>`, e `/readyz` fica aberto, o que serve à prontidão do ADR.

## V2 Confiança de pasta na TUI remota

Comando: `codex resume <id> --remote ws://... -C <cwd> -c 'projects."<cwd>".trust_level="trusted"'`, em `CODEX_HOME` temporário.

| Cenário | Gate "Trust this folder?" |
| --- | --- |
| TUI sem `-c`, cwd desconhecido do servidor | aparece |
| TUI com `-c projects."<cwd>".trust_level` | aparece |
| TUI com `CODEX_HOME` próprio que já confia no cwd | aparece |
| TUI sem `-c`, cwd que o `config.toml` do servidor já confia | não aparece, histórico visível |
| Servidor iniciado com `-c 'projects."<cwd>".trust_level="trusted"'` (pontilhado) | aparece |
| Servidor iniciado com `-c 'projects={"<cwd>"={trust_level="trusted"}}'` (tabela inline) | não aparece, histórico visível |

Veredito: negativo. Com `--remote`, o gate é decidido pela configuração do servidor, e nem o `-c` da TUI nem o `CODEX_HOME` próprio da TUI o removem. O `config/read` do servidor ficou idêntico antes e depois das TUIs, então a TUI não altera o servidor.

O fallback do ADR (`CODEX_HOME` temporário só da TUI) também falha. O caminho viável é o override de tabela inline no processo do servidor, sem gravar em `~/.codex`. Como o servidor já é do Glimpse, a confiança vale só para o cwd do executor.

## V3 Override de hooks

Comandos: `-c 'hooks.state."<key>".trusted_hash="<hash>"'` e `-c 'hooks.state={"<key>"={trusted_hash="<hash>"}}'`, com um `hooks.json` de usuário de dois hooks `PreToolUse` que gravam marcadores e a ferramenta de shell chamada pelo modelo falso.

| Configuração | `hooks/list` | Marcadores | `hook/completed` |
| --- | --- | --- | --- |
| Nenhuma confiança | os dois `untrusted` | nenhum | nenhum |
| Chave pontilhada via `-c` | os dois `untrusted`, aviso `hooks.state."<key>" is ignored` | nenhum | nenhum |
| Tabela inline com a chave A | A `trusted`, B `untrusted` | só A | `preToolUse:completed` |
| Confiança de B só no `config.toml` | B `trusted` | só B | `preToolUse:completed` |
| `config.toml` confia B e `-c` tabela inline confia A | os dois `trusted` | A e B | dois `preToolUse:completed` |

Veredito: parcial. A forma pontilhada é ignorada, provavelmente porque a chave contém pontos e dois-pontos, e a forma de tabela inline funciona. A tabela inteira via `-c` mescla com o `config.toml`, não substitui, então a janela comum não perde a confiança do usuário e não precisa mudar.

O ADR deve especificar o override como `hooks.state={"<key>"={trusted_hash="<hash>"}}` com a chave entre aspas. O critério de aceite do achado 2 foi satisfeito: com confiança o marcador aparece e chega `hook/completed` com `eventName` `preToolUse`, e sem confiança o marcador não aparece. O matcher do hook usou o nome `Bash`, e o nome interno `exec_command` não casou.

## V4 Eco do `clientUserMessageId`

Comando: `turn/start {threadId, input, clientUserMessageId:"dispatch-..."}` seguido de `thread/turns/list {threadId, limit:20, sortDirection:"desc"}`.

Saída: `userMessage {"clientId":"dispatch-bbf91a556236", ...}`. O mesmo valor aparece na notificação `item/completed` do `userMessage` e em `thread/read` com `includeTurns`.

Veredito: sim. A reconciliação por `clientId` do ADR funciona sem o fallback por `turnRef`.

## V5 Dois clientes e aprovação

Comando: dois clientes ws e depois um ws mais a TUI, no mesmo servidor, com `turn/start` do texto `TRIGGER_TOOL` e `approvalPolicy:"on-request"`.

| Cenário | Saída observada |
| --- | --- |
| Clientes A e B, B com `thread/resume` | os dois receberam `item/commandExecution/requestApproval` |
| A responde `{decision:"decline"}` | B recebe `serverRequest/resolved` com o mesmo `requestId` |
| ws mais TUI, turno iniciado pelo ws | o ws recebeu o request e a TUI mostrou "Would you like to run the following command?" |
| Thread sem turno prévio | `thread/resume` falha com `no rollout found for thread id` |

Veredito: sim. O servidor difunde o request a todos os clientes inscritos na thread, e quem responde primeiro fecha o pedido nos demais, como o ADR prevê. A thread só aceita `thread/resume` depois do primeiro turno, o que importa para o adaptador de segundo cliente.

## V6 Queda e reinício

Comando: `SIGKILL` no app-server com um turno de ferramenta longa em voo, novo app-server no mesmo `CODEX_HOME`, `thread/resume` e `thread/turns/list`.

Saída: o turno em voo (`inProgress` no ack) volta como `interrupted`, localizado pelo `clientId`, e o turno anterior segue `completed`. A thread volta `idle`, e `thread/turns/list` funciona depois do reinício.

Veredito: sim. O status que o adaptador lê depois da queda é `interrupted`, não `inProgress`. O ADR mapeia `interrupted` para `failed(interrupted)`, então a reconciliação deve tratar o despacho `sent` sem `turn/completed` observado e com turno `interrupted` como `failed(executor_down)`, e reservar `failed(interrupted)` para a interrupção pedida pelo Glimpse.

## V9 Órfão por pid e hash do token

Comando: `/proc/<pid>/cmdline` e `/proc/<pid>/stat` (campo `starttime`) de um servidor com `--ws-token-sha256`, depois `SIGTERM`, `SIGKILL` e `kill(-pgid)`.

| Verificação | Saída observada |
| --- | --- |
| Pid identificado pelo hash | `true`, e o processo pai e um `sleep` não casam |
| Pgid do servidor | igual ao pid (`detached:true`) |
| Árvore com turno de ferramenta | 11 processos (`codex`, `git`, `zsh`, `tail`, `sleep`) |
| `SIGTERM` com turno em voo | servidor segue vivo após 6 s |
| `SIGKILL` no pid | nenhum descendente órfão ao final |
| Pid depois da morte | não casa mais com o hash |

Veredito: sim. Pid, hash na linha de comando e `starttime` identificam o órfão sem ambiguidade. A espera de 3 s seguida de `SIGKILL` do ADR é necessária, porque o `SIGTERM` não encerra o servidor durante um turno, e `kill(-pgid)` fica como garantia contra descendentes.

## V14 Dois servidores sobre o mesmo `CODEX_HOME`

Comando: dois `codex app-server --listen ws://...` com o mesmo `CODEX_HOME`, três rodadas de turno simultâneo e `PRAGMA integrity_check`.

| Verificação | Saída observada |
| --- | --- |
| Partida simultânea em `CODEX_HOME` novo | falha em 3 de 3 tentativas: `failed to initialize sqlite state runtime` |
| Partida simultânea em home já inicializado | 2 de 2 prontos, em 3 de 3 tentativas |
| Partida sequencial | os dois prontos em cerca de 100 ms |
| Três rodadas de turno simultâneo | `completed/completed` nas três |
| Servidor 2 lê a thread do servidor 1 | `thread/read` ok, 2 turnos |
| Servidor 2 retoma a thread do servidor 1 | recusado: `already has an active writer` |
| Integridade dos seis bancos sqlite | todos `ok` |

Veredito: parcial. Os servidores convivem sem corrupção de estado, mas a primeira inicialização do estado é uma corrida e perde um dos dois. A serialização do início do ADR cobre isso, e vale também para o primeiro uso de um `CODEX_HOME` vazio.

A recusa de `thread/resume` por escritor ativo é uma guarda do Codex e protege contra dois servidores gravando a mesma thread. Ela impõe que o serviço antigo seja encerrado antes de o novo retomar a thread, o que o ciclo de vida do ADR já faz.

## M1 Memória

Comando: `VmRSS` da árvore de processos do app-server, lido em `/proc`, ocioso sem cliente, com cliente, depois de um turno e com amostra a cada 100 ms durante um turno com ferramenta.

| Estado | Medição (duas execuções) |
| --- | --- |
| Ocioso, sem cliente | 92 e 119 MiB |
| Ocioso, com cliente e `initialize` | 98 e 131 MiB |
| Depois de thread e turno de texto | 156 e 188 MiB |
| Pico durante turno com ferramenta | 156 e 188 MiB |

Veredito: sim. A estimativa de capacidade é de cerca de 120 MiB por executor ocioso e 190 MiB com turno. O modelo falso não gera contexto longo nem streaming real, então o valor em turno real tende a ser maior, e o limite de 8 executores (cerca de 1,5 GiB) deve ser reavaliado com medição em uso real.

## Pendências e limites

Nenhum ponto exigiu modelo pago, então não há ponto marcado como "não testado, exige modelo pago". O comportamento da TUI foi lido pelo texto da tela, sem captura de imagem.

Os pontos V7, V8, V10 a V13 pertencem ao opencode e ficam fora deste relatório. O relatório da prova anterior foi movido para `docs/research/orchestration-spike-executor-service.md`.
