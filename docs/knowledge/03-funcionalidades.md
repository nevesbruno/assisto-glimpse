# Funcionalidades

Inventário inicial por área, com tamanho, dependências e decisão provisória. As decisões definitivas saem do inventário de uso. Números de 2026-11-13, HEAD `9e1fe4c7`.

## Visão geral

| Área | Linhas | Arquivos | O que faz | Dependência crítica | Decisão provisória |
|---|---:|---:|---|---|---|
| Canvas | 53.846 | 362 | Pan, zoom, nós, seleção, colagem, snapping, espaços, colapso | React Flow 12 | Otimizar e manter |
| Shell | 28.107 | n/d | Header, sidebar, Command Center, Control Center, Agent Island, busca | React, CSS | Otimizar e manter |
| Settings | 15.601 | 104 | 8 páginas primárias, 18 ids resolvidos | React, formulários | Podar e manter |
| Agent | 19.024 | n/d | Providers, sessões, permissões, transcript, MCP | CLIs externas | Manter, é o core |
| Terminal | 17.675 | 112 | xterm, WebGL, restauração, geometria | xterm 6 e node-pty | Manter, alto risco |
| Plugins | 10.169 | n/d | Instalação, views HTML, temas, backend Node | iframe, Node | Manter, mas isolar |
| Orchestration | 6.860 | n/d | Papéis, filas, execução paralela | Agent, Worker | Manter, avaliar uso |
| Worktree | 4.475 | n/d | Git, worktrees, PRs | Git | Manter |
| Task | 2.268 | n/d | Tarefas, status, sessões de agente | Agent | Manter |
| i18n | 5.349 | 71 | 1.900 chaves, en e zh-CN | Nenhuma | Manter |
| Website nodes | 3.228 | 37 | Sites embutidos, WebContentsView | Chromium | Isolar e medir |
| Documento e imagem | 874 | 3 | Monaco, imagem, pasta | Monaco | Manter, avaliar uso |
| Notas | 237 | 1 | Textarea puro | React | Manter, baixo custo |
| Performance monitor | 1.500 | n/d | Frame, heap, processos, jank | Electron | Manter, é ferramenta |
| Update | 649 | n/d | Auto-update | electron-updater | Manter |

Nota sobre o terminal: 17.675 linhas são o componente dentro do workspace, incluindo integração com xterm, geometria e restauração. O contexto `terminal` isolado tem 4.997 linhas. As duas medidas são válidas para escopos diferentes.

## Canvas

É o coração do produto. Concentra pan e zoom com trackpad, arraste, redimensionamento, multi-seleção, snapping, colagem, LOD, espaços, colapso animado, minimapa, explorer e menus de contexto.

- 362 arquivos, 53.846 linhas.
- 168 hooks, 27.830 linhas.
- 61 usos de `useStore` e `useStoreApi` do React Flow.
- Efeitos visuais próprios: parede de pixels WebGL2 com 2.059 linhas de shaders, partículas com 2.171 linhas, sinais de janela com 7 arquivos.
- Invariantes de geometria e aparência documentados em `docs/ui`.

Risco: qualquer mudança no canvas mexe em geometria, foco, teclado, acessibilidade e animação ao mesmo tempo. É a área com mais testes E2E e a mais cara de refatorar.

## Terminal

Integra xterm 6 com sete addons: fit, webgl, ligatures, search, serialize, unicode11 e web-links. Tem patch local para o addon WebGL.

- 112 arquivos, 17.675 linhas.
- Budget de contextos WebGL, fallback para DOM, health check e limpeza de transform.
- Restauração de scrollback, geometria canônica, attach authority e calibração por cliente.
- Multi-client documentado em `docs/terminal/MULTI_CLIENT_ARCHITECTURE.md`.

Risco: o terminal é um subsistema com invariantes de geometria, autoridade e durabilidade. Não é uma biblioteca plug-and-play. Qualquer otimização precisa preservar os testes de TUI e multi-client.

## Agent

Providers Claude Code, Codex e outros, com sessões, permissões, transcripts, MCP e retomada.

- 19.024 linhas.
- Integração com CLIs externas e com o filesystem.
- Sessões sobrevivem a reinícios.
- Permissões e aprovações de MCP são parte do fluxo.

Risco: o comportamento depende de CLIs de terceiros, que mudam sem aviso. A camada de provider precisa ser isolada e testada com fixtures.

## Shell

Header, sidebar, Command Center, Control Center, Agent Island, busca global e notificações.

- 28.107 linhas.
- Agent Island concentra o estado de "agente precisa de você".
- Command Center e Control Center são entradas de comando e gestão de sessões.
- Busca global cruza canvas e saída de terminal.

Risco: é a área mais visível e a que mais sofre com inconsistência de design. É candidata natural ao sistema de motion.

## Settings

Oito páginas primárias e dezoito ids resolvidos. Cobre terminal, aparência, canvas, worker, agente, plugins, notificações, atalhos, tarefas, modelos, integrações, diagnóstico, projetos e experimental.

- 15.601 linhas.
- Muitas opções são raramente usadas.
- Algumas opções existem para diagnosticar o próprio app.

Risco: settings vira depósito de flags. O inventário deve marcar quais opções têm uso real e quais podem ser removidas ou agrupadas.

## Plugins

Plataforma madura para um app alpha.

- 10.169 linhas.
- 27 documentos em `docs/plugins`, 3.452 linhas.
- Instalação local ou por repositório, sem rebuild.
- Contribuições: view HTML, comandos, skills, temas, sidebar, preferências, backend Node.
- Views rodam em iframe com SDK injetado.
- Temas são CSS que sobrescreve tokens do host.

Risco: é a feature que mais depende do browser. Qualquer movimento em direção a uma UI nativa quebra o contrato. Também é a área com maior superfície de segurança, porque plugins rodam com confiança local.

## Website nodes

Sites embutidos no canvas.

- 2.755 linhas no main, 473 no nó.
- Usa `WebContentsView` nativo, posicionado por frame a partir do React Flow.
- Tem LOD, oclusão e congelamento por zoom.
- O próprio código documenta que zoom de página quebra o mapeamento.

Risco: é uma feature cara e frágil. O inventário deve responder se ela é usada o suficiente para justificar a manutenção.

## Documento, imagem e pasta

- Documento usa Monaco com workers.
- Imagem tem render próprio.
- Pasta abre o explorer.

Risco: Monaco é um subsistema de 32 MB de bundle com workers. Se o uso for baixo, um editor mais simples resolve.

## Notas e tarefas

- Notas são um textarea puro, sem markdown. Baixo custo.
- Tarefas têm status, tags, sessões de agente e janelas próprias.
- Tarefas são o elo entre planejamento e execução de agente.

Risco: tarefas podem competir com ferramentas externas. O valor está na ligação com o canvas e com a sessão de agente, não no gerenciador de tarefas em si.

## Orchestration

Papéis, filas, links e execução paralela.

- 6.860 linhas.
- Depende de agent, worker e persistência.
- É uma das áreas mais autorais do fork.

Risco: se o uso diário não passar por ela, vira código morto caro. O inventário precisa de telemetria local ou de uma revisão honesta de uso.

## Performance monitor

Já existe e é uma das melhores ferramentas para o inventário.

- Frame p95, frame max, long tasks, heap, nós do DOM, terminais, instâncias de xterm, CPU, memória por processo, threads e registro de jank.
- Diagnóstico de processos e relatório copiável.

Decisão: manter e usar como instrumento oficial de medição. Não construir outro monitor.

## O que está morto ou subutilizado

O levantamento encontrou:

- `react-router-dom` sem imports.
- `tailwindcss` declarado, mas sem classes utilitárias, `@theme` ou `@apply`.
- `class-variance-authority` e `tailwind-merge` sem uso.
- Parser de diff em `workspaceCanvas/view/unifiedDiff.ts`, referenciado apenas pelo próprio teste.
- Visualizador de diff não implementado.

Esses itens são candidatos a poda, mas precisam de verificação de uso indireto antes de remover.

## O que falta

- Diff viewer, apesar de o produto falar de git e PRs.
- Um sistema de motion unificado.
- Uma política de uso de memória e contextos WebGL.
- Um inventário de features reais versus aspiracionais.
- Uma estratégia explícita de fork e upstream.

## Próximo passo

Transformar esta tabela numa página por área, com: o que faz, quem usa, onde vive, testes, dependências, risco, custo de divergir do upstream e decisão. A ordem é canvas, terminal, agent, plugins, shell, settings, e o resto.
