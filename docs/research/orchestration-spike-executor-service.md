# Prova técnica: executores comandados como serviço

Data: 2026-11-08. Codex 0.167.0, opencode 2.2.6. Nenhum código de produto tocado, nada em `~/.codex`, `~/.claude` ou config do opencode. Os servidores do spike são próprios (portas 47831 e 47832); o daemon do Codex e o `opencode serve --service` que já rodavam na máquina não foram mexidos.

## Resumo

| Item | Veredito |
| --- | --- |
| A1 esquema e métodos do Codex | Funcionou |
| A2 turno comandado por script (ws) | Funcionou, 2,5 a 3,2 s ponta a ponta |
| A3 TUI `--remote` no mesmo servidor | Funcionou, com dois portões de confiança que a TUI exige |
| A4 hooks globais no app-server | Rodam como hooks de usuário, mas começam `untrusted` e pedem confiança |
| B opencode serve + SSE + TUI | Funcionou, 1,9 s ponta a ponta, TUI viu a sessão |

## A. Codex

### A1. Esquema

```
codex app-server generate-json-schema --out scripts/spikes/executor-service/codex-schema
```

Diretório com 4,6 MB (`ClientRequest.json`, `ServerRequest.json`, `ServerNotification.json`, `v2/*`). Métodos relevantes:

| Necessidade | Método |
| --- | --- |
| Handshake | `initialize` (request) e `initialized` (notificação do cliente) |
| Iniciar thread | `thread/start` (`cwd`, `sandbox`, `approvalPolicy`, `ephemeral`, `model`) |
| Retomar thread | `thread/resume`, `thread/read`, `thread/turns/list`, `thread/loaded/list` |
| Iniciar turno | `turn/start` (`threadId`, `input: [{type:"text",text,text_elements:[]}]`, `sandboxPolicy`, `approvalPolicy`, `cwd`) |
| Turno iniciado/concluído | notificações `turn/started` e `turn/completed` (`params.turn.status`) |
| Mensagem final | `item/completed` com `item.type == "agentMessage"` e `item.text`; streaming em `item/agentMessage/delta` |
| Pedido de aprovação | requests do servidor para o cliente: `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval`, `item/tool/requestUserInput`, `mcpServer/elicitation/request` (responder com `{decision}`) |
| Interromper | `turn/interrupt` (`threadId`, `turnId`); também `turn/steer` para injetar texto em turno ativo |
| Hooks | `hooks/list` |

Transportes do `codex app-server --listen`: `stdio://` (padrão), `unix://`, `unix://PATH`, `ws://IP:PORT`, `off`. Em ws o servidor expõe `/readyz` e `/healthz` e faz bind só em localhost.

### A2. Turno comandado por script

Script: `scripts/spikes/executor-service/codex-spike.mjs` (Node 22, `WebSocket` nativo, sem dependências).

```
node scripts/spikes/executor-service/codex-spike.mjs            # só A2 e hooks
node scripts/spikes/executor-service/codex-spike.mjs --tui      # inclui A3
```

Sobe `codex app-server --listen ws://127.0.0.1:47831`, `initialize`, `hooks/list`, `thread/start` com `sandbox:"read-only"` e `approvalPolicy:"never"` em diretório temporário, `turn/start` com "responda apenas OK".

Saída real (execuções representativas):

```
initialize ok            +865ms
thread/start ok          254ms (outras execuções: 71ms, 88ms)
turn/start ack           46ms
turn/completed status=completed  latencia turn/start->turn/completed 2783ms (outras: 2473ms, 3181ms)
mensagem final: "OK"
```

Notificações vistas: `thread/started`, `thread/status/changed`, `turn/started`, `item/started`, `item/completed`, `item/agentMessage/delta`, `thread/tokenUsage/updated`, `account/rateLimits/updated`, `turn/completed`, `mcpServer/startupStatus/updated`, `remoteControl/status/changed`.

Nenhum pedido de aprovação surgiu (prompt trivial). O script responde `decline` a qualquer request do servidor, para nunca travar.

### A3. TUI remota no mesmo servidor

Comando que a TUI recebeu (sob pseudo-terminal via `script -qfec`, 120x40, `node-pty` não está instalado em `node_modules`):

```
CODEX_HOME=<tmp> codex resume <threadId> --remote ws://127.0.0.1:47831 -C <cwd>
```

O que aconteceu, em ordem:

1. Conectou ao mesmo servidor e retomou a thread criada pelo script. A tela mostrou o histórico: `responda apenas OK` e `• OK  Worked for 2s`, rodapé `GPT-6-Luna medium · <cwd>`.
2. Gate 1, "Trust this folder?": a TUI pergunta confiança da pasta no lado cliente, mesmo para pasta já coberta por pai confiável. Opção 1 grava a decisão. Para não escrever em `~/.codex`, a TUI foi rodada com `CODEX_HOME` temporário (aceita com Enter). Aviso inofensivo: `could not create PATH aliases ... temporary dir`.
3. Gate 2, "5 hooks are new or changed": opções Review, Trust all, Continue without trusting. Escolhido "3" (continuar sem confiar). Ver A4.
4. Acompanhamento ao vivo: com a TUI aberta, o script iniciou um segundo turno ("responda apenas LIVE") via `turn/start` no mesmo servidor. A TUI mostrou o prompt, `Working (0s • esc to interrupt)` e emitiu o OSC `state=working:app=codex`. Ou seja, turnos disparados pelo serviço aparecem em tempo real na TUI anexada.

Limitações observadas: sem atalho para pular os dois gates; com o `~/.codex` real eles tendem a sumir depois de uma confiança prévia, mas isso não foi testado por proibição de alterar a config. A thread criada pelo script é persistente (`ephemeral:false`, necessário para `resume`) e deixa sessão em `~/.codex/sessions` do usuário (efeito colateral inevitável do app-server, fora do repo).

### A4. Hooks globais

`hooks/list` no app-server do spike devolveu os hooks de `~/.codex/hooks.json` (`source:"user"`, `enabled:true`, `isManaged:false`) com `trustStatus:"untrusted"` e `currentHash`. A TUI anexada pediu confiança ("5 hooks are new or changed. Hooks can run outside the sandbox after you trust them"). Conclusões:

- O app-server carrega os hooks globais do usuário e os lista, mas trata como não confiáveis até haver decisão (a TUI, com `CODEX_HOME` limpo, mostrou o gate).
- No turno do script (A2) nenhum hook de `PreToolUse` disparou, pois o prompt não usou ferramenta; a execução efetiva de hook em turno com ferramenta não foi exercitada.
- Para o produto: o serviço precisa tratar o estado de confiança (via `hooks/list` e a API de config) ou aceitar que hooks não confiáveis não rodam.

## B. opencode

Script: `scripts/spikes/executor-service/opencode-spike.mjs`.

```
node scripts/spikes/executor-service/opencode-spike.mjs
SPIKE_HOLD_MS=40000 node scripts/spikes/executor-service/opencode-spike.mjs --hold   # mantém servidor para a TUI
```

### API (v2)

- `opencode serve --hostname 127.0.0.1 --port 47832` em diretório temporário. Imprime `server password <senha aleatória>`. Autenticação: HTTP Basic `opencode:<senha>` (Bearer e header próprio dão 401). Uma senha por boot, também aceita via `OPENCODE_SERVER_PASSWORD` no cliente.
- OpenAPI: `GET /openapi.json` (com auth, 139 paths). `GET /doc` serve a UI HTML.
- Prefixo `/api`. Diferente da API antiga usada em `src/contexts/agent/infrastructure/watchers/OpenCodeSessionApi.ts` (`GET /session?directory=` e `GET /session/status`), que o v2 não expõe mais como JSON (devolve o HTML da UI).

Endpoints usados:

| Passo | Chamada |
| --- | --- |
| Info | `GET /api/info` |
| Eventos | `GET /api/event` (SSE, `?types=` filtra) |
| Criar sessão | `POST /api/session` corpo `{title, location:{directory}, model:{providerID,id}}` resposta `{data:{id,...}}` |
| Mensagem assíncrona | `POST /api/session/{id}/prompt` corpo `{text, delivery?: "steer"\|"queue"}` |
| Ler resposta | `GET /api/session/{id}/message?order=desc&limit=5` |
| Interromper | `POST /api/session/{id}/interrupt` |
| Permissões | `GET /api/session/{id}/permission`, `POST .../permission/{requestID}/reply`; formulários `.../form` |
| Ativas | `GET /api/session/active` |

Eventos observados no turno: `session.created`, `session.inbox.enqueued`, `session.execution.started`, `session.inbox.delivered`, `session.step.started`, `session.text.started|delta|ended`, `session.step.ended`, `session.usage.updated`, `session.execution.succeeded` (fim; também `failed` e `interrupted` esperados). Mensagem final: item `type:"assistant"` com `content:[{type:"text",text:"OK"}]`, seguido de `type:"idle", outcome:"succeeded"`.

Latência (modelo `anthropic/claude-haiku-4-5`):

```
prompt aceito (POST retorna)      ~1058ms (inclui bootstrap do projeto na primeira chamada)
evento de fim: session.execution.succeeded   latencia prompt->fim 1911ms
```

Custo do prompt trivial: US$ 0,022 (17,6 mil tokens de cache write do system prompt do opencode).

### TUI

```
OPENCODE_SERVER_PASSWORD=<senha> opencode --server http://127.0.0.1:47832 --session <id>
```

(sob `script -qfec`, no diretório da sessão). A TUI conectou ao servidor do spike e abriu a sessão: tela com título `spike`, mensagem do usuário `responda apenas OK`, resposta `OK`, rodapé `Build · anthropic/claude-haiku-4-5 · 688ms`, `17.6K · $0.02`. Aviso `Plugin failed: context-mode` (plugin do usuário, não relacionado). O comando `opencode attach` não existe nesta versão; o equivalente é a flag `--server` do comando raiz.

## Riscos e limitações

- Codex: protocolo marcado `[experimental]`; o esquema muda entre versões, então gerar o esquema na versão instalada e fixar versão mínima.
- Codex: a TUI remota exige dois gates de confiança (pasta e hooks) que só se resolvem por interação ou config do usuário. Um serviço que abre a TUI para o usuário precisa deixar isso à vista.
- Codex: ws em loopback sem token no spike; para qualquer exposição usar `--remote-auth-token-env` e bind local.
- Codex: threads persistentes poluem o histórico do usuário (`~/.codex/sessions`).
- opencode: API v2 diferente da usada hoje pelo Glimpse (`/session`, `/session/status`); a migração precisa dos endpoints `/api/*` e de Basic auth com senha gerada por boot (capturar do stdout ou definir `OPENCODE_SERVER_PASSWORD`, não testado).
- opencode: existe um serviço de fundo (`opencode serve --service`) já rodando na máquina; o spike usou servidor próprio em outra porta para não interferir.
- opencode: a ausência de pedido de permissão no prompt trivial significa que o fluxo de aprovação (`/permission`, `/form`) não foi exercitado, apenas mapeado no OpenAPI. Mesma ressalva para `turn/interrupt` e `/interrupt`: mapeados, não disparados.
- Os dois spikes encerram o servidor no `finally`; foi verificado com `ps` que não sobrou processo (ver relatório).
