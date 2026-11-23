# Rune: avaliação de viabilidade

## A pergunta

Vale reescrever o Glimpse em Rune, um framework de UI nativo em Rust, para sair do Electron e ganhar desempenho e qualidade de animação?

## Resposta curta

Não. A viabilidade técnica existe, a viabilidade econômica não. O Rune ainda não tem quatro coisas que o Glimpse usa todos os dias: terminal completo, webview para plugins, plataforma de plugins compatível e releases com updater. O custo estimado de paridade visual é de 52 a 76 pessoa-mês, sem contar terminal e plugins.

A decisão é manter o Electron e investir em otimização, sistema de motion e base limpa.

## O que é o Rune

Framework de UI nativo em Rust, com renderer próprio em wgpu, layout Taffy, texto Parley, springs analíticos, acessibilidade AccessKit e shells por plataforma. Roda em macOS, Windows, Linux e web experimental.

- Repositório: `https://github.com/anomalyco/rune`
- Licença MIT.
- Cerca de 7 mil estrelas e 2.373 commits no levantamento.
- 366 issues abertas.
- Não aceita pull requests. Contributions são por issue.
- Não tem releases. Consumidores pinam um rev da branch `dev`.
- O próprio plano diz que a pergunta "substituir o app Electron?" será decidida no milestone M3, depois de reconstruir as telas do OpenCode Desktop.

## O que o Rune tem de bom

- Renderer GPU com um draw call por frame.
- Springs analíticos com retarget preservando posição e velocidade.
- Presença e transições de entrada e saída.
- Texto com IME, seleção e edição rica.
- Acessibilidade via AccessKit.
- Layout flex, grid e block com cache.
- Virtualização de listas.
- Canvas com pan e zoom, inclusive trackpad.
- Markdown, syntax highlight, mermaid, vídeo e áudio.
- Blur, backdrop, gradientes, sombras e materiais.
- Grid de terminal com damage por linha.
- Ferramentas headless de teste, árvore de elementos, trace e gravação.
- Binário de 10,9 MB e frame CPU de 0,13 ms em app pequeno.

## O que falta para o Glimpse

| Necessidade | Situação no Rune | Impacto |
|---|---|---|
| Terminal completo | Só o grid de renderização. Emulação, scrollback, seleção, busca, links, ligaduras e IME teriam que ser portados | Bloqueio alto |
| Plugins HTML/CSS/JS | Não há webview. A issue #412 está aberta | Bloqueio alto |
| Backend Node de plugins | Não existe equivalente | Bloqueio alto |
| Editor Monaco | TextEdit próprio, sem autocomplete, multi-cursor e folding | Bloqueio médio |
| Web UI universal | Alvo web experimental com WebGPU, sem fallback WebGL e sem acessibilidade espelhada | Bloqueio médio |
| Website nodes | Sem webview | Bloqueio médio |
| Auto-update e instalador | Não há releases nem updater | Bloqueio médio |
| Ecossistema de componentes | `rune-kit` em construção | Bloqueio médio |
| Estabilidade de API | Pré-release, pin de rev | Risco alto |
| Governança | Sem PRs externos, roadmap centralizado | Risco alto |

## O headless não é um motor de render

O modo headless do Rune renderiza o app inteiro para PNG, MP4, árvore de elementos e trace de movimento, com relógio virtual e scripts de entrada. É excelente para goldens, testes de geometria e gravação de demos.

Não é uma API de frames em tempo real. Não há função para "desenhe este frame numa textura que outro app componha". O Rune abre a própria janela com winit e desenha com wgpu. Usar o headless como motor de animação dentro do Electron exigiria renderizar frames, codificar e enviar por IPC. Em 1080p, são cerca de 8 MB por frame. Inviável para 60 ou 120 fps.

## Rotas de integração e por que falham

| Rota | Como funcionaria | Por que não |
|---|---|---|
| Processo separado enviando frames | Rune renderiza e manda bitmap para o renderer | Latência, banda e CPU de encode inviáveis |
| Janela nativa sobreposta | Rune abre janela sem moldura sobre o canvas | Perde z-order, DPI, eventos, acessibilidade e composição |
| Rune como wasm no renderer | Compilar o alvo web e embutir num canvas | É um app completo, não uma lib de componente. Segundo runtime e segundo layout |
| `rune-motion` via wasm | Usar só a crate de springs | Integra com o DOM por conta própria, adiciona toolchain Rust, ganho marginal |

## Custo de reescrita

A camada visual tem 172.870 linhas. A estimativa é de 52 a 76 pessoa-mês para paridade visual e de interação, sem plugins e sem terminal. Em calendário, 12 a 18 meses com 4 ou 5 engenheiros. Com uma pessoa e agentes, 3 a 4 anos.

O custo não é só código:

- 285.133 linhas de teste e 2.181 seletores E2E teriam que ser reescritos.
- A plataforma de plugins quebraria.
- A Web UI perderia alcance.
- O auto-update e o instalador teriam que ser reconstruídos.
- O fork do Rune teria que ser mantido, e o Rune não aceita PRs.

## O que o Rune ensina

O valor do Rune para o Glimpse é conceitual:

- Springs analíticos são melhores que curvas fixas para interação.
- Retarget deve preservar posição e velocidade, não reiniciar.
- Presença deve animar entrada e saída sem desmontar o elemento no meio.
- Animação deve ficar fora do ciclo de render do React.
- Reduced motion deve ser padrão, não exceção.
- Tokens de motion devem ser poucos e obrigatórios.
- Efeitos de GPU devem ter orçamento e pausa.

## Quando revisitar

A decisão não é eterna. Revisitar se:

- O Rune chegar a um release estável com compatibilidade declarada.
- O Rune tiver webview nativa.
- O Rune tiver um terminal completo ou um crate mantido.
- O Rune tiver updater e instalador.
- O Glimpse precisar de um recurso que o Electron não entrega e que o Rune entrega.
- O custo de manter o Electron superar o custo de migrar, com números.

Enquanto isso, o Rune serve como referência de design e como laboratório isolado, nunca como dependência de produção.

## Decisão

- **Data**: 2026-11-13.
- **Decisão**: não migrar. Electron é a base.
- **Consequência**: foco em otimização, motion system, base limpa e compatibilidade com upstream.
- **Revisão**: a cada 6 ou 12 meses, com critérios escritos.
