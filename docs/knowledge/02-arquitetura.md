# Arquitetura

Levantamento de 2026-11-13, HEAD `9e1fe4c7`. Os números de linhas vêm do código atual e servem para dimensionar esforço, não para julgar qualidade.

## Visão de processos

O Glimpse tem quatro processos principais e dois auxiliares:

| Processo | Entry point | Tamanho | Papel |
|---|---|---|---|
| Electron main | `src/app/main/index.ts` | 315 arquivos, 40.913 linhas (31.688 em controlSurface/Worker) | Única `BrowserWindow`, IPC, `WebContentsView` de sites, menus, updater, atalhos, clipboard |
| Preload | `src/app/preload/index.ts` | 15 arquivos, 1.349 linhas | Expõe `window.opencoveApi` com 26 namespaces e 137 canais IPC |
| Renderer Electron | `src/app/renderer/main.tsx` | 1.303 arquivos, 187.483 linhas | Toda a UI |
| Renderer web | `src/app/renderer/web-main.tsx` | 17 arquivos, 2.765 linhas | Substitui a API do preload por HTTP e WebSocket |
| Worker | `src/app/worker/index.ts` | 11 arquivos, 1.058 linhas, mais Control Surface | Backend HTTP/WS, PTY hub, SQLite, providers de agente |
| PTY host | `src/platform/process/ptyHost/entry.ts` | 30 arquivos, 3.183 linhas | Utility process com `node-pty` |
| Plugin host | `src/contexts/plugins/infrastructure/pluginHostEntry.ts` | child process | Backend Node opcional de plugins |
| CLI | `src/app/cli` | 64 arquivos, 8.569 linhas | Cliente do Control Surface |

## O achado arquitetural mais importante

O renderer não importa `electron` em nenhum arquivo. Todo acesso passa pelo preload, e existe um renderer web que fala com o Worker por HTTP e WebSocket. Isso significa que a UI já é portável e que o processo main é, em boa parte, um proxy fino.

Consequências:

- Migrar de Electron um dia não exigiria reescrever o backend.
- O custo de qualquer migração está na camada visual, não no processo principal.
- A arquitetura atual já tem o desacoplamento que muita gente só constrói quando decide migrar.

O acoplamento real está em 26 namespaces de API e em 4.114 linhas de adaptadores (preload e browser). Há 329 chamadas de `window.*` em 156 arquivos. Isso é grande, mas é uma superfície explícita, não um vazamento.

## Fluxo de dados

```
Renderer (React)
  -> window.opencoveApi (preload)
    -> IPC (137 canais, 96 handlers)
      -> Electron main
        -> Control Surface (HTTP/WS)
          -> Worker
            -> PTY host (node-pty)
            -> SQLite
            -> filesystem
            -> providers de agente
```

No modo web, o renderer troca o preload por um cliente HTTP/WS. O `browserPtyClient` usa o mesmo contrato. O Worker é o dono da verdade durável: sessões, PTY, banco e arquivos.

## Camadas do código

| Camada | Linhas | Observação |
|---|---:|---|
| Contexts, presentation/renderer | 117.895 | UI e lógica de apresentação |
| Contexts, infrastructure | 24.467 | Adaptadores |
| Contexts, application | 16.897 | Casos de uso |
| Contexts, main-ipc | 5.639 | Handlers IPC |
| Contexts, domain | 9.083 | Modelos e regras |
| Shared, contracts | 12.093 | Contratos de IPC, DTOs e normalização |
| Shared, runtime | 1.905 | Utilidades de runtime |
| Shared, sync | 1.705 | Sincronização e merge de estado |
| Shared, design | 1.200 | Tokens e geração de tema |
| Platform | 8.879 | PTY, persistência, OS, terminal |
| App shell | 28.107 | Header, sidebar, command center, agent island |
| Worker | 1.058 | Entrada do backend |
| CLI | 8.569 | Cliente do Control Surface |

A organização segue DDD e Clean Architecture, com contextos por domínio: workspace, agent, terminal, plugins, settings, task, space, worktree, filesystem, orchestration, project, session, topology, update, issue report, integration, browser, clipboard, release notes.

## Estado no renderer

- 7 stores Zustand: `useAppStore`, `useAgentAttentionStore`, `useAgentWaitingSinceStore`, `useScrollbackStore`, `useWebsiteWindowStore`, `useCanvasCollapseStore`, `useViewportSpaceStore`.
- 1 store vanilla: `orchestrationLinksStore`.
- 3 stores artesanais: `pluginCatalogStore`, `pluginDetailsStore`, `worktreeInfoStore`.
- 27 React Contexts.
- O grafo do canvas vive no React Flow, com 61 usos de `useStore` e `useStoreApi`.
- `useNodesStore` espalha cerca de 3.000 linhas por 20 arquivos, com `useState` e refs.
- 60 chamadas de `requestAnimationFrame`, 5 arquivos com canvas 2D e 2 com WebGL2.
- O canvas tem 168 hooks e 27.830 linhas só de hooks.

O canvas é altamente imperativo. Isso não é um defeito por si só, mas explica por que a camada visual é difícil de portar para um framework declarativo.

## Persistência

- Estado de app e workspace em JSON, enviado pelo preload, persistido em SQLite.
- Debounce e flush no quit.
- 3.031 linhas em `utils/persistence`.
- 24 usos de `localStorage` para estado de UI.
- Scrollback e sessões têm produtores e consumidores espalhados entre renderer, main e Worker.

O case study de jitter mostra o risco: quando a verdade durável tem múltiplos escritores e o caminho de input faz IPC ou persistência, o resultado é perda de estado, atraso ou replay competindo com a interação.

## Pontos de extensão

- **Plugins**: instalação independente, manifest, views HTML em iframe, comandos, skills, temas, backend Node.
- **Temas**: CSS que sobrescreve 350 tokens `--cove-*`, com contrato de motion.
- **Providers de agente**: contribuições registradas por provider.
- **Control Surface**: command, query e event, usado por CLI, Web UI e plugins.
- **Website nodes**: `WebContentsView` nativo posicionado por frame a partir das coordenadas do React Flow.

## Implicações para o plano

1. O backend e o Worker não são o gargalo de uma otimização. A camada visual é.
2. A UI já tem um alvo web. Isso é uma válvula de escape e uma rede de testes.
3. O acoplamento com Electron é explícito e pequeno em relação ao total. Não é ele que impede evoluir.
4. O canvas e o sistema visual são o centro de gravidade. Qualquer refatoração precisa começar por eles.
5. A persistência e o PTY são áreas de confiabilidade, não de estética. Devem ser medidas separadamente.

## Perguntas abertas

- Quanto do comportamento do canvas depende de detalhes do React Flow que não estão documentados?
- Qual é o custo real de manter o renderer web em paralelo ao Electron?
- O Worker pode virar o único dono da verdade durável, inclusive de scrollback?
- Quanto do main process pode ser removido se o Worker assumir mais responsabilidades?
- Existe algum caminho para reduzir os 26 namespaces de API sem quebrar plugins e Web UI?
