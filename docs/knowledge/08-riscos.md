# Riscos

Riscos ordenados por probabilidade e impacto. Cada um tem sinal de alerta e mitigação. A lista é viva e deve ser revisada a cada fase.

## Matriz

| Risco | Probabilidade | Impacto | Nível |
|---|---|---|---|
| Paridade de terminal | Alta | Alto | Crítico |
| Interação do canvas | Alta | Alto | Crítico |
| Plugins em HTML/CSS | Alta | Alto | Crítico |
| Website nodes com WebContentsView | Média | Alto | Alto |
| Sistema visual em CSS | Alta | Médio | Alto |
| Conflito com upstream | Alta | Alto | Crítico |
| Programa de base sem entrega | Média | Alto | Alto |
| Otimização no lugar errado | Média | Médio | Médio |
| Colisão de schema do banco | Média | Alto | Alto |
| Perda de scrollback ou sessão | Média | Crítico | Alto |
| Colisão de pasta de dados e marca | Baixa | Médio | Médio |
| Duplicação de correções do upstream | Alta | Médio | Alto |
| Dependência de CLIs externas | Alta | Médio | Alto |
| Overengineering de motion | Média | Médio | Médio |
| Decisão de não migrar virar dogma | Média | Médio | Médio |

## Riscos técnicos

### 1. Paridade de terminal

O app usa xterm 6 com sete addons, patch local do addon WebGL e 17.675 linhas de integração. Restauração, geometria canônica, attach authority e multi-client têm invariantes documentados.

**Sinal de alerta**: qualquer mudança que altere geometria, scrollback ou autoridade de attach sem teste de contrato.

**Mitigação**: tratar o terminal como subsistema congelado. Mudanças só com teste de TUI, multi-client e restauração. Não trocar o emulador.

### 2. Interação do canvas

O canvas tem 53.846 linhas, 362 arquivos, 168 hooks e 61 usos de store do React Flow. Pan, zoom, trackpad, snapping, seleção, colagem, LOD e colapso vivem juntos.

**Sinal de alerta**: mudanças em `useTrackpadGestures`, `useNodeDragSession`, `useSelectionDraft`, `useSpaceDrag` sem teste de geometria.

**Mitigação**: mudanças pequenas, com trace e teste E2E. Não refatorar o canvas inteiro. Extrair comportamento para hooks testáveis, não reescrever.

### 3. Plugins em HTML/CSS

Views de plugin são iframes com SDK injetado. Temas são CSS que sobrescreve 350 tokens. Backend é Node em child process.

**Sinal de alerta**: qualquer proposta de UI nativa que não tenha caminho para iframe ou para CSS.

**Mitigação**: manter a plataforma como está. Isolar o contrato. Não prometer compatibilidade que não existe. Medir uso real de plugins.

### 4. Website nodes

Usa `WebContentsView` nativo, posicionado por frame a partir do React Flow. Zoom de página quebra o mapeamento. São 2.755 linhas no main e 473 no nó.

**Sinal de alerta**: bugs de posição, oclusão ou foco ao dar zoom ou arrastar.

**Mitigação**: decidir se a feature fica. Se ficar, tratar como caso especial e testar com zoom e LOD. Se não, remover com critério e comunicar.

### 5. Sistema visual em CSS

22.712 linhas de CSS, 350 tokens, 46 `backdrop-filter`, 184 sombras, 40 animações definidas em 23 arquivos, com 75 usos. Não há sistema de motion.

**Sinal de alerta**: cada feature nova inventa animação, duração ou curva.

**Mitigação**: tokens, classificação por custo, lib de motion e migração em ondas. Sem reescrever CSS global.

## Riscos de processo

### 6. Conflito com upstream

O fork quer continuar recebendo updates. Refatorações transversais, renomeações e poda de dependências aumentam o conflito.

**Sinal de alerta**: PR do fork que toca dezenas de arquivos por motivo estético, ou que muda CSS global.

**Mitigação**: branch espelho, PRs curtos, mudanças aditivas, feature flags, testes de contrato e `FORK.md` com o mapa de divergências.

### 7. Programa de base sem entrega

Inventário, motion, poda e gates podem consumir meses sem valor visível. O dono tem muitas ideias e pode perder o interesse.

**Sinal de alerta**: duas semanas sem entrega perceptível no uso diário.

**Mitigação**: uma entrega visível por onda. Critério de parada. Cada fase tem um artefato que o dono usa.

### 8. Otimização no lugar errado

Sem atribuição de custo, é fácil otimizar animação quando o gargalo é xterm, IPC ou React Flow.

**Sinal de alerta**: otimização sem baseline e sem comparação antes e depois.

**Mitigação**: profiling primeiro. Só agir sobre culpado medido. Reverter o que não mover a métrica.

## Riscos de produto

### 9. Colisão de schema do banco

O fork declara `DB_SCHEMA_VERSION = 14`. O upstream declara 15, com tabelas de retomada de sessão e linhagem de nós. Se as duas versões 14 tiverem conteúdos diferentes, o merge pode pular a migração do upstream ou fazer o banco do fork ser recusado.

Os dados locais são de teste e podem ser recriados. O risco não é perder histórico: é a migração rodar errada e o merge parar.

**Sinal de alerta**: banco do fork aberto após merge, tabela faltando, modo de recuperação estrita recusando o arquivo.

**Mitigação**: separar o banco da orquestração do banco do app, congelar mudanças de schema no fork, escrever teste de migração de um banco do fork para o esquema combinado e manter backup como rede de segurança.

### 10. Pasta de dados e marca

O produto ainda se chama OpenCove, usa `appId` `dev.deadwave.opencove` e a pasta de dados `opencove`. O app oficial não está instalado e o perfil local é de teste, então o risco só importa se o Glimpse for distribuído.

**Sinal de alerta**: só aparece na distribuição, quando os dois apps puderem abrir o mesmo banco ou disputar o atualizador.

**Mitigação**: se distribuir, isolar pasta de dados, appId, nome do produto e canal de atualização. Se for só local, manter o perfil separado e documentar.

### 11. Perda de scrollback ou sessão

É o risco mais destrutivo para a confiança. O case study mostra que a causa era múltiplos escritores e durabilidade no ciclo de vida errado.

**Sinal de alerta**: sessão que volta vazia, scrollback truncado, replay competindo com input.

**Mitigação**: um dono para a verdade durável, separação entre estado interativo e durável, persistência fora do caminho quente, teste de recuperação.

### 12. Duplicação de correções do upstream

O fork está 99 commits atrás. Correções feitas no fork podem já existir no upstream, com outra mensagem e outro SHA.

**Evidência**: o commit `c05a3964` do Bruno, de 2026-11-13, corrige o mesmo sintoma do `b0c14242` do upstream, de 2026-11-08: agente novo tratado como restaurado e terminal esperando saída.

**Sinal de alerta**: corrigir um sintoma sem antes buscar no upstream por termo, issue e teste.

**Mitigação**: merge semanal, busca no upstream antes de cada correção e descarte explícito do que já está coberto.

### 13. Dependência de CLIs externas

Claude Code, Codex e outros mudam sem aviso. A camada de provider pode quebrar.

**Sinal de alerta**: release nova de CLI quebra sessão ou permissão.

**Mitigação**: providers isolados, fixtures, testes de contrato e fallback claro.

### 14. Overengineering de motion

Criar um sistema elaborado que ninguém migra.

**Sinal de alerta**: mais tempo no sistema que nas animações.

**Mitigação**: lib existente, tokens, três ondas, critério de parada.

### 15. Dogma de não migrar

A decisão de ficar no Electron é correta agora, mas pode envelhecer.

**Sinal de alerta**: recusar uma tecnologia nova sem reavaliar com critérios.

**Mitigação**: revisão a cada 6 ou 12 meses, com critérios escritos e números.

## Riscos de segurança e privacidade

- Plugins rodam com confiança local. Um plugin malicioso tem acesso ao backend e ao filesystem.
- Sessões de agente podem conter dados sensíveis em transcripts e scrollback.
- A Web UI exposta na rede precisa de senha e escopo claro.
- O relatório de diagnóstico pode incluir caminhos e conteúdo de terminal.

Mitigação: revisar permissões de plugin, não expor Web UI sem senha, revisar o que entra em relatórios e logs, e tratar transcripts como dados sensíveis.

## Como usar esta lista

- Antes de cada fase, revisar os riscos aplicáveis.
- Um risco sem mitigação escrita não entra em execução.
- Um risco que se materializou vira caso em `docs/cases`.
- A lista não serve para paralisar. Serve para escolher onde colocar teste e onde aceitar risco.
