# Números

Levantamento de 2026-11-13, HEAD `9e1fe4c7`. Serve para dimensionar esforço e acompanhar evolução. Não é um julgamento de qualidade.

## Tamanho do código

| Área | Arquivos | Linhas |
|---|---:|---:|
| `src` total (ts, tsx, css, mjs, cjs) | 2.431 | 324.691 |
| Renderer (UI e CSS) | 1.303 | 187.483 |
| Renderer TS/TSX | 1.182 | 164.771 |
| Renderer CSS | 123 | 22.712 |
| Main process | 315 | 40.913 |
| Preload | 15 | 1.349 |
| Contexts, todas as camadas | 1.247 | 175.705 |
| Platform | 63 | 8.879 |
| Shared | 208 | 18.488 |
| Worker | 11 | 1.058 |
| CLI | 64 | 8.569 |

O renderer é 57,7% do `src`. A camada visual a reescrever, sem specs, é de 172.870 linhas, sendo 150.158 de TS/TSX e 22.712 de CSS.

## Contextos por domínio

| Contexto | Linhas |
|---|---:|
| Workspace | 97.990 |
| Settings | 21.385 |
| Agent | 19.024 |
| Plugins | 10.169 |
| Orchestration | 6.860 |
| Terminal | 4.997 |
| Worktree | 4.475 |
| Task | 2.268 |
| Issue report | 1.726 |
| Topology | 1.644 |
| Space | 1.146 |
| Filesystem | 1.052 |
| Browser | 752 |
| Update | 649 |
| Integration | 523 |
| System | 475 |
| Release notes | 359 |
| Clipboard | 63 |
| Session | 49 |
| Project | 21 |

## Testes

| Tipo | Arquivos | Linhas |
|---|---:|---:|
| Total | 1.727 | 285.133 |
| Unit | 1.024 | 159.349 |
| E2E | 420 | 81.331 |
| E2E specs | 338 | 67.391 |
| Contract | 102 | 19.815 |
| Integration | 74 | 13.374 |

O repositório tem 5.961 casos de teste, 709 `data-testid` no `src` e 2.181 seletores E2E. Essa é a rede de segurança que qualquer refatoração precisa preservar.

## Componentes e estado

- 296 componentes `.tsx` sem spec.
- 291 hooks `use*.ts`, somando 42.695 linhas.
- 7 stores Zustand, 1 vanilla e 3 artesanais.
- 27 React Contexts.
- 61 usos de `useStore` e `useStoreApi` do React Flow.
- 60 chamadas de `requestAnimationFrame`.
- 5 arquivos com canvas 2D e 2 com WebGL2.

## Dependências de UI

| Dependência | Versão | Uso | Dificuldade fora do browser |
|---|---|---|---|
| `@xterm/xterm` e addons | 6.0.0 | 59 arquivos | Máxima |
| `@xyflow/react` | 12.10.1 | 212 arquivos | Alta |
| `monaco-editor` | 0.55.1 | Documento | Alta |
| `react-markdown` e `remark-gfm` | 10.1.0 / 4.0.1 | README de plugin | Baixa |
| `@dnd-kit` | 6.3.1 / 10.0.0 | Sidebar | Média |
| `react-resizable-panels` | 4.7.3 | Settings e sidebar | Média |
| `zustand` | 5.0.11 | Estado | Baixa |
| `electron` | 41.5.1 | Shell | Alta |
| `electron-updater` | 6.8.3 | Updates | Média |
| `node-pty` | 1.1.0 com patch | PTY | Média |

Dependências declaradas e sem uso: `react-router-dom`, `tailwindcss`, `class-variance-authority`, `tailwind-merge`.

## Bundle

- Renderer compilado: 32 MB em `out/renderer`.
- Main: 2,9 MB em `out/main`.
- O bundle inclui workers do Monaco e fontes de codicons.

## Estilo e animação

- 22.712 linhas de CSS.
- 350 tokens `--cove-*`.
- 46 `backdrop-filter`.
- 184 `box-shadow`.
- 62 `filter`.
- 83 declarações `transition`.
- 75 usos de `animation`, em 28 arquivos.
- 40 definições de `@keyframes`, em 23 arquivos.
- 92 `transform`.
- Parede de pixels WebGL2 com 2.059 linhas de shaders.
- Camada de partículas com 2.171 linhas.

## Acoplamento

- 0 imports de `electron` no renderer.
- 329 chamadas de `window.*` em 156 arquivos.
- 137 canais IPC e 96 handlers registrados.
- 26 namespaces de API no preload.
- 11 arquivos usam `ptyEventHub`, o único adaptador de PTY.
- 17 arquivos e 2.765 linhas de adaptador web.

## Custo de reescrita da camada visual

Estimativa baseada em 2.500 a 3.500 linhas por pessoa-mês, taxa conservadora para código de UI com testes:

| Bloco | Linhas | Pessoa-mês |
|---|---:|---:|
| Canvas, spaces, colapso, explorer, menus | 53.846 | 16 a 22 |
| Shell | 28.107 | 8 a 11 |
| Terminal nodes, sem emulador | 17.675 | 7 a 11 |
| Settings | 15.601 | 5 a 7 |
| CSS e design system | 22.712 | 4 a 6 |
| Demais nós e utilidades | 21.593 | 6 a 9 |
| Plugins, temas, worktree, tasks | 9.370 | 5 a 8 |
| i18n | 5.349 | 1 a 2 |
| **Total** | **172.870** | **52 a 76** |

Adicionais não incluídos:

- Substituir 4.114 linhas de adaptadores.
- Reescrever 121 specs de renderer e 338 specs E2E.
- Substituir o emulador de terminal.
- Substituir o Monaco.
- Reconstruir a plataforma de plugins.

Calendário: 12 a 18 meses com 4 ou 5 engenheiros para paridade visual e de interação, sem plugins e sem paridade de terminal. Com uma pessoa e agentes, 3 a 4 anos.

## Limitações da estimativa

- A taxa de linhas por pessoa-mês é genérica. Não mede o ritmo real do dono com agentes.
- O custo de testes E2E é subestimado, porque seletores e geometria mudam.
- O custo de manter o fork do Rune não está incluído, porque a decisão foi não migrar.
- O custo de oportunidade não está incluído. Cada mês de reescrita é um mês sem feature nova.
- Linhas de código não medem complexidade. O canvas tem 53 mil linhas, mas concentra a maior parte do risco.

## Como reproduzir

```sh
# total de linhas por extensão
find src -type f \( -name '*.ts' -o -name '*.tsx' \) -print0 | xargs -0 cat | wc -l

# linhas por contexto
for d in src/contexts/*/; do
  l=$(find "$d" -type f \( -name '*.ts' -o -name '*.tsx' \) -print0 | xargs -0 cat 2>/dev/null | wc -l)
  echo "$(basename $d): $l"
done | sort -t: -k2 -nr

# animações e transições
grep -rn "animation:" src --include=*.css | wc -l
grep -rn "transition:" src --include=*.css | wc -l
```

## O que acompanhar

- Linhas por área, para detectar crescimento sem controle.
- Número de stores e contexts, para detectar fragmentação de estado.
- Número de animações e filtros, para detectar regressão de custo.
- Tempo de build e de teste, para detectar perda de velocidade de iteração.
- Tamanho do bundle, para detectar dependências gordas.
