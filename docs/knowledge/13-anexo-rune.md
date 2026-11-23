# Anexo: dados brutos do Rune

Dados coletados em 2026-11-13, para sustentar a decisão de não migrar. Servem para revisões futuras, não para uso em produção.

## Ficha do projeto

| Item | Valor |
|---|---|
| Repositório | `https://github.com/anomalyco/rune` |
| Descrição | Native UI framework |
| Licença | MIT |
| Estrelas | cerca de 7 mil |
| Forks | 266 |
| Commits | 2.373 |
| Issues abertas | 366 |
| Pull requests | 9 |
| Branch principal | `dev` |
| Releases | Nenhuma. Consumidores pinam um rev de `dev` |
| Política de contribuição | Não aceita pull requests. Contributions por issue |
| Alvo | macOS, Windows, Linux e web experimental |
| Stack | Rust 2024, wgpu, winit, Taffy, Parley, AccessKit |

## O que existe

| Capacidade | Evidência |
|---|---|
| Renderer GPU | Um pipeline instanciado, um draw call por frame |
| Texto | Parley, HarfRust, skrifa, fontique, atlas de glifos |
| Layout | Taffy 0.15 com cache por Constraints |
| Animação | Springs analíticos, tweens, decay, presença, transições |
| Tokens | Cores OKLCH, espaço, raio, tipografia e motion |
| Acessibilidade | AccessKit em Windows, macOS e Linux |
| IME | Protocolos nativos por plataforma |
| Canvas | Pan, zoom, trackpad, coordenadas de mundo e janela |
| Virtualização | Listas e growth stacks |
| Markdown | `rune-kit` com code fences syntax-colored |
| Syntax highlight | Lexers próprios, 80 linguagens |
| Mermaid | Flowchart, sequence e state diagrams |
| Vídeo e áudio | Player e recorder |
| Efeitos | Blur, backdrop, gradientes, sombras, materiais |
| Grid de terminal | Issue #813, damage por linha |
| Headless | PNG, MP4, tree, trace, relógio virtual |
| Web | WebGPU experimental, wasm |
| Multi-window | Overlays, janelas compactas, tray |

## O que não existe

| Lacuna | Evidência |
|---|---|
| Terminal completo | Só o grid de renderização. Sem emulação, scrollback, seleção, busca, links ou ligaduras |
| Webview | Issue #412 aberta. Sem handle nativo da janela para `wry` |
| Plataforma de plugins HTML/CSS/JS | Modelo do Rune é Luau (issue #274), não iframe |
| Editor de código | TextEdit rico, sem Monaco |
| Releases e updater | Sem releases. Sem auto-update |
| Web universal | WebGPU experimental, sem fallback WebGL, acessibilidade não espelhada, Safari não verificado em dispositivo |
| Governança aberta | Sem PRs externos |

## Benchmarks publicados

| Métrica | Valor |
|---|---|
| Binário | 10,9 MB, 9,3 MB stripped |
| Frame CPU médio | 0,13 ms |
| Frame CPU p95 | 0,29 ms |
| Primeiro frame | 1,4 ms |
| GPU init | cerca de 11 ms |
| Instâncias | 174 em um draw call |
| Grid de terminal 200x60, full redraw | 2.461 µs p50 |
| Grid de terminal 200x60, uma linha | 402 µs p50 |
| Grid de terminal 200x60, nada mudou | 302 µs p50 |
| 1.300 nós equivalentes, full redraw | 62.508 µs p50 |

Os números são de app pequeno e headless em Apple Silicon a 2x. Não representam um app com 20 terminais, 50 nós e plugins.

## Issues relevantes

| Issue | Título | Estado | Leitura |
|---|---|---|---|
| #813 | Grid: a terminal's screen as one element that draws only the rows that changed | Fechada | Prova que o Rune quer suportar terminal, mas só no render |
| #412 | Native web view element | Aberta | Prova que webview não existe e é difícil, especialmente no Wayland |
| #274 | Luau: rune-luau gives hosts the API a plugin platform needs | Fechada | Prova que o modelo de plugins é Luau, não HTML/JS |
| #105 | Evaluation notes: embedding Rune in a Tauri 2 host | Fechada, retirada | Não serve como evidência |

## O que o plano do Rune diz

Trechos relevantes do `PLAN.md`:

- O teste principal é recriar o OpenCode Desktop em Rune e elevar a barra.
- O milestone M3 cobre sidebar, session list, transcript, composer, diff view, command palette, popovers e menus.
- A pergunta "o Rune substitui o app Electron?" será decidida no M3, com evidência.
- Os três maiores riscos declarados são: input de texto e IME, paridade visual com o Chromium e escopo.
- O web target é experimental e não tem fallback WebGL nem acessibilidade espelhada.

## Implicação para o Glimpse

O Rune é um framework promissor, mas está resolvendo os próprios riscos. O Glimpse tem necessidades que o Rune ainda não cobre: terminal, plugins, webview, Monaco e Web UI universal. Migrar agora seria apostar o produto no roadmap de outra empresa, sem releases e sem direito a PR.

## Critérios para revisitar

Revisitar a decisão se todos os itens abaixo forem verdadeiros:

- Release estável com compatibilidade declarada.
- Webview nativa ou caminho oficial para conteúdo web.
- Terminal completo ou crate mantido com paridade funcional.
- Updater e instalador.
- Custo de manter o Electron maior que o custo de migrar, com números.
- O Glimpse precisar de algo que o Electron não entrega.

Enquanto isso, acompanhar os milestones M2 e M3 e o issue #412.
