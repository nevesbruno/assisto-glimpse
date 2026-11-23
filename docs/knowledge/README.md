# Biblioteca de conhecimento do Glimpse

Esta pasta reúne os estudos, medições, análises e o plano de evolução do fork Glimpse, feito a partir do OpenCove. É material de consultoria do fork, não documentação pública do upstream. O upstream mantém `docs/` para arquitetura já implementada; aqui ficam análises, estimativas, decisões e planos que não devem ser enviados como PR ao OpenCove.

## Como ler

| Se você quer entender | Leia |
|---|---|
| O produto, a dor e os princípios | `01-produto.md` |
| Processos, camadas e fluxo de dados | `02-arquitetura.md` |
| O que o app faz, área por área | `03-funcionalidades.md` |
| Tamanho, testes, dependências e custo | `04-numeros.md` |
| Onde o desempenho dói e como medir | `05-performance.md` |
| O problema das animações artesanais e o plano de motion | `06-animacoes-e-motion.md` |
| Se vale reescrever em Rune | `07-rune-viabilidade.md` |
| Os riscos que podem quebrar o plano | `08-riscos.md` |
| As fases, entregáveis e critérios de saída | `09-plano-de-evolucao.md` |
| Como conviver com o upstream e merges | `10-fork-e-upstream.md` |
| Decisões firmes e críticas ao próprio plano | `11-decisoes-e-criticas.md` |
| Links, comandos e glossário | `12-referencias.md` |
| Dados brutos do Rune | `13-anexo-rune.md` |
| Roteiro do inventário funcional | `14-template-inventario.md` |
| Recomeçar do zero versus adaptar o fork | `15-recomecar-do-zero.md` |
| Organograma navegável do estado atual | `organograma/index.html` |
| Panorama visual em uma página | `panorama/index.html` |
| Ideias futuras e o que ficou parkeado | `17-ideias-futuras.md` |
| Mesa de coordenação (ideia futura) | `16-mesa-de-coordenacao.md` |
| Protótipo da Mesa (ideia futura) | `coordenacao/index.html` |
| Spike da interface (ideia futura) | `spike-controle/relatorio.md` |

## Resumo executivo

O Glimpse é um fork do OpenCove, um workspace espacial em Electron, React 19, React Flow, xterm 6 e Monaco. Ele organiza agentes, terminais, tarefas e notas num canvas infinito. O fork tem 324.691 linhas em `src`, 2.431 arquivos, 285.133 linhas de teste e 5.961 casos. É um produto grande, em alpha, com uso diário pretendido.

A decisão central é não migrar para outra stack. O Electron fica. O foco ativo é construção: reconciliar o fork com o upstream por agentes e concluir a orquestração, que ainda não está pronta para o uso diário. Medição de uso, suavização, poda e features novas vêm depois, nessa ordem. A Mesa de coordenação foi parkeada como ideia futura.

O Rune foi avaliado e descartado como runtime. Ele não tem terminal completo, webview, plataforma de plugins compatível, releases ou updater. O headless dele é ferramenta de teste e gravação, não motor de render embutível. O que vale aproveitar é o modelo de animação: springs analíticos, retarget com velocidade, presença e reduced motion.

O plano tem uma semana de reconciliação e cinco fases: concluir a orquestração, primeiro uso real e medição de atrito, suavização e caminho quente, poda e gates, e por fim features novas. A medição de uso só começa depois que a orquestração estiver usável. Cada fase tem critério de saída e métrica. O merge semanal é trabalho de agente, em três classes de risco.

## Status dos documentos

| Documento | Status | Última revisão |
|---|---|---|
| `01-produto.md` | inicial | 2026-11-13 |
| `02-arquitetura.md` | inicial | 2026-11-13 |
| `03-funcionalidades.md` | inicial | 2026-11-13 |
| `04-numeros.md` | inicial | 2026-11-13 |
| `05-performance.md` | inicial | 2026-11-13 |
| `06-animacoes-e-motion.md` | inicial | 2026-11-13 |
| `07-rune-viabilidade.md` | inicial | 2026-11-13 |
| `08-riscos.md` | inicial | 2026-11-13 |
| `09-plano-de-evolucao.md` | inicial | 2026-11-13 |
| `10-fork-e-upstream.md` | inicial | 2026-11-13 |
| `11-decisoes-e-criticas.md` | inicial | 2026-11-13 |
| `12-referencias.md` | inicial | 2026-11-13 |
| `13-anexo-rune.md` | inicial | 2026-11-13 |
| `14-template-inventario.md` | inicial | 2026-11-13 |
| `15-recomecar-do-zero.md` | inicial | 2026-11-14 |
| `organograma/index.html` | inicial | 2026-11-14 |
| `panorama/index.html` | inicial | 2026-11-20 |
| `16-mesa-de-coordenacao.md` | parkeado | 2026-11-20 |
| `coordenacao/index.html` | parkeado | 2026-11-20 |
| `spike-controle/relatorio.md` | parkeado | 2026-11-20 |
| `spike-controle/probe.mjs` | parkeado | 2026-11-20 |
| `17-ideias-futuras.md` | inicial | 2026-11-20 |

## Convenções

- **Fato**: medido no código ou em documento do repositório, com data e SHA.
- **Estimativa**: cálculo de ordem de grandeza, com premissas explícitas.
- **Decisão**: escolha firmada, com data e motivo.
- **Hipótese**: ideia a validar, não usar como base de execução.

Os números foram levantados em 2026-11-13, no HEAD `9e1fe4c7`, salvo indicação contrária. Números de código envelhecem rápido. Ao usar um documento para decidir, refaça a medição se o SHA mudou.
