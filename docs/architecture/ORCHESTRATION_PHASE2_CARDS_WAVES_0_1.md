# Partição da fase 2: ondas 0 e 1

Parte da [partição da fase 2](ORCHESTRATION_PHASE2_CARDS.md), que traz as regras de execução, o diagrama, as ondas seguintes e a tabela de arquivos que mudam de dono. Este arquivo guarda os cards das ondas 0 e 1, já entregues ou em entrega. Os testes citados por id (U, C, I, E) estão em [Riscos e testes](ORCHESTRATION_RISKS_AND_TESTS.md).

Depois da revisão de 09/11/2026 (admissão por estado), alguns arquivos da onda 1 passam ao F2-01b, no início da onda 2: `dispatch.ts`, `repositories.ts`, `hostPorts.ts`, `orchestrationTables.ts`, `schema.ts`, `orch.ts`, `appError.ts` e `PERSISTENCE.md`. O F2-02b assume `dto/orchestration.ts` para os resultados das operações, e o registro das doze `orch.*` no `registry.ts` fica com o F2-02c e depois com o F2-14.

## Onda 0

### F2-00 Viabilidade do Codex

| Campo | Valor |
| --- | --- |
| Objetivo | Responder V1 a V6, V9, V14 e M1 do ADR com o Codex 0.167.0 instalado, sem código de produto |
| Papel | dev-backend |
| Depende de | Nenhum |
| Arquivos donos | `scripts/spikes/executor-service/viabilidade-codex.mjs` (não versionado), `docs/research/orchestration-viability-codex.md`, `docs/research/orchestration-spike-executor-service.md` (o `RESULTADO.md` da prova, movido) e `.gitignore` |

Aceite verificável:

- Cada ponto traz comando, saída observada e veredito entre sim, parcial e negativo.
- Tudo roda com `CODEX_HOME` temporário e a API de respostas falsa de `tests/e2e/agent.prompt.real-codex.helpers.ts`, sem custo de modelo.
- O `sha256sum` de `~/.codex/config.toml` e `~/.codex/hooks.json` sai igual antes e depois.
- Veredito negativo em V1, V4 ou V5 devolve o ADR ao arquiteto antes da onda 3.
- O relatório da prova entra no git em `docs/research/`, e `scripts/spikes/` passa a ser ignorado pelo git.

### OC-00 Viabilidade do opencode v2

| Campo | Valor |
| --- | --- |
| Objetivo | Responder V7, V8, V10, V11, V12 e V13 com o opencode v2 do caminho padrão, chamado como `opencode`, e `OPENCODE_CONFIG_DIR` apontando para uma cópia temporária de `~/.config/opencode` |
| Papel | dev-backend |
| Depende de | Limpeza do ambiente pelo Bruno: só a v2, comando `opencode` e configuração em `~/.config/opencode` |
| Arquivos donos | `scripts/spikes/executor-service/viabilidade-opencode.mjs` (não versionado) e `docs/research/orchestration-viability-opencode.md` |

Aceite verificável:

- Mesmo formato do F2-00 para cada ponto.
- V10 registra o que o comando raiz faz com `--hostname`, `--port` e `--model`, e diz qual forma da correção mínima vale.
- V13 informa tokens de cache write da primeira e da segunda sessão no mesmo diretório, com custo em dólar.
- O hash dos arquivos de `~/.config/opencode` sai igual antes e depois, e um `opencode serve` do usuário, se estiver rodando, segue com o mesmo pid.
- `which -a opencode` mostra um caminho só, e `opencode --version` mostra a v2, como prova da limpeza.

## Onda 1

### F2-01 Domínio e portas

| Campo | Valor |
| --- | --- |
| Objetivo | Criar o domínio puro (ligação, máquina de estados do despacho, rodadas, compositor de aviso e matriz de autorização) e as interfaces das portas |
| Papel | dev-backend |
| Depende de | Nenhum |
| Arquivos donos | `src/contexts/orchestration/domain/agentLink.ts`, `dispatch.ts`, `roundPolicy.ts`, `noticeComposer.ts` e `orchestrationAuthorization.ts`; `src/contexts/orchestration/application/ports/*.ts`; `tests/unit/contexts/orchestration/domain/*.spec.ts` |

Aceite verificável:

- U-01, U-04, U-05 e U-09 verdes em `pnpm exec vitest run tests/unit/contexts/orchestration/domain`.
- O domínio importa só `shared`, e `pnpm arch:test` passa sem aresta nova.
- As portas cobrem a tabela de portas do ADR, sem implementação.

### F2-02 Contratos e DTO da orquestração

| Campo | Valor |
| --- | --- |
| Objetivo | Declarar as doze operações `orch.*`, os erros, os DTOs e o evento `orchestration.links.updated` |
| Papel | dev-backend |
| Depende de | Nenhum |
| Arquivos donos | `src/shared/contracts/controlSurface/operations/domains/orch.ts`, `src/shared/contracts/dto/orchestration.ts`, `src/shared/contracts/dto/error.ts`, `src/shared/errors/appError.ts`, `src/shared/contracts/dto/sync.ts`, `src/shared/contracts/persistedAppState.ts`, `src/shared/sync/persistedAppStateValidation.ts`, `normalizePersistedAppStateForMerge.ts` e `mergePersistedAppStates.ts`, e `src/shared/contracts/dto/index.ts` se reexportar; `tests/contract/controlSurface/orch.contract.spec.ts`, `tests/unit/shared/persistedAppStateValidation.spec.ts` e `mergePersistedAppStates.spec.ts` |

Aceite verificável:

- C-02 verde.
- `orch.ts` exporta as doze operações com os escopos da matriz do ADR (interact, read e admin); o registro no `registry.ts` fica com o F2-02c (provisório) e depois com o F2-14.
- O zod recusa texto acima de 32.768 bytes, caractere de controle fora de tab e quebra de linha, e `dispatchId` fora do formato uuid.
- O DTO de ligação traz `kind`, `state` e `health`.
- O estado persistido ganha o campo do espelho de ligações, só para exibição, e a validação e a mesclagem de `src/shared/sync/` o aceitam e deixam o valor do Worker prevalecer.
- `pnpm build:cli` passa.

### F2-03 Esquema SQLite 14

| Campo | Valor |
| --- | --- |
| Objetivo | Subir o esquema para 14 com as quatro tabelas, os índices e a chave `orchestration_links_revision` |
| Papel | dev-backend |
| Depende de | Nenhum |
| Arquivos donos | `src/platform/persistence/sqlite/constants.ts`, `schema.ts` e `migrate.ts`; `tests/contract/platform/persistenceInstalledUpgradeSupport.ts`, `persistenceSchemaColumns.ts` e `persistenceStore.orchestrationSchema.spec.ts` (novo); `src/platform/persistence/sqlite/orchestrationTables.ts`; `tests/contract/platform/persistenceStore.migrations.spec.ts` e `persistenceStoreSortOrderMigration.spec.ts`; `docs/architecture/PERSISTENCE.md` |

Aceite verificável:

- C-01 verde, com a matriz de upgrade instalado passando de 1 a 13 para 14.
- Os índices únicos parciais recusam segunda ligação ativa e segundo despacho em voo para o mesmo executor (o F2-01b estende o de despacho a `queued`).
- A coluna `spawn_request_id` existe em `agent_links`, e o índice único `(orchestrator_node_id, spawn_request_id)` recusa o segundo spawn com o mesmo `requestId`.
- A segunda abertura do banco deixa tudo igual (reparo idempotente).
- As colunas da fase 3 (`kind`, pedido de conexão e contagem de mensagens) já existem, com padrão neutro para a fase 2.

### F2-04 Subconjunto do protocolo Codex

| Campo | Valor |
| --- | --- |
| Objetivo | Versionar só o pedaço do esquema do Codex que o adaptador usa, com manifesto e teste de contrato |
| Papel | dev-backend |
| Depende de | F2-00 (lista de métodos e campos confirmada, inclusive o eco do V4) |
| Arquivos donos | `scripts/codex-protocol/extract-subset.mjs`; `src/contexts/orchestration/infrastructure/codex/protocol/codex-protocol.subset.json`, `manifest.json` e `codexProtocol.ts`; `tests/fixtures/codex-protocol/*.json`; `tests/contract/orchestration/codexProtocolSubset.spec.ts` e `codexProtocolInstalled.spec.ts`; `.prettierignore` (só a entrada do subconjunto gerado) |

Aceite verificável:

- C-03 verde sempre, e C-04 verde com `OPENCOVE_TEST_REAL_CODEX=1` no Codex 0.167.0.
- Um subconjunto adulterado, com um campo lido removido, faz o C-04 falhar com diff legível.
- O manifesto registra versão, métodos e tamanho do subconjunto, com meta abaixo de 300 KB.
- Nada de `scripts/spikes/` entra no diff.
