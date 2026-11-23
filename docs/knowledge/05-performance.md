# Performance

## O princípio

Toda decisão de performance precisa de número, cenário e critério de sucesso. Sem isso, a otimização vira opinião e a regressão volta sem ser percebida.

O app já tem um monitor embutido. Ele é o instrumento oficial do baseline.

## O que o monitor já mede

- Frame p95 e frame max.
- Long tasks.
- JS heap e variação de heap.
- Nós do DOM.
- Número de terminais e de instâncias de xterm.
- CPU do Electron.
- Memória em uso por processo.
- Threads.
- Processos do app, de agentes externos, de shells e do console host.
- Registro de jank com os últimos oito incidentes.

Isso cobre sintomas. Não cobre atribuição por causa. O baseline precisa adicionar atribuição.

## Suíte de performance existente

O repositório já tem `tests/perf/canvas-zoom.perf.ts` e `tests/perf/canvas-drag.perf.ts`, com cenários de arraste e zoom, 100 nós, parede de pixels, terminais e perfil separado. O baseline deve adotar essa suíte como baseline oficial, em vez de inventar outra. Completar apenas o que falta: memória com 10 terminais, tempo de retomada, comportamento em segundo plano e registro de hardware, GPU e frequência da tela.

## O que o case study de jitter ensina

O caso documentado em `docs/cases/CASE_STUDY_CANVAS_JITTER_AND_TERMINAL_DURABILITY.md` mostra que o jitter do canvas não era culpa do Electron. Era arquitetura:

1. Múltiplos escritores para a mesma verdade: viewport, sessão, scrollback.
2. Input do usuário atualizando estado, persistindo, e o replay sobrescrevendo a interação.
3. Durabilidade entregue a um ciclo de vida que pode ser suspenso, como o renderer.
4. Trabalho de IPC, persistência e serialização no caminho quente.

A consequência é direta: reescrever a UI em outra stack, com a mesma arquitetura, recria os mesmos bugs. A correção é separar estado interativo de estado durável, escolher um dono para a verdade e tirar trabalho pesado do caminho de input.

## Onde o Electron dói de verdade

| Dor | Existe? | Gravidade | Observação |
|---|---|---|---|
| Startup lento | Sim | Média | Depende do bundle e do número de processos |
| Memória alta | Sim | Alta | 10 a 20 terminais e vários processos auxiliares |
| Limite de contextos WebGL | Sim | Alta | Cada xterm WebGL consome um contexto. O app já tem budget e fallback |
| Jank no pan com muitos nós | Sim | Média | Depende de culling, transform e filtros |
| Animações de layout | Sim | Média | 40 animações definidas, muitas em propriedades caras |
| Blur e backdrop-filter | Sim | Alta | 46 ocorrências, caro em áreas grandes |
| IPC no caminho quente | Sim | Alta | Já causou perda de scrollback e jitter |

## Onde o Electron não é o culpado

- Renderização de retângulos e texto em si. O Chromium é rápido nisso.
- Composição de transform e opacity. É GPU e barato.
- WebGL do xterm. Já é usado.
- A maior parte do consumo de memória de um terminal vem do buffer e do processo PTY, não do Chromium.
- O jitter do canvas documentado era arquitetural.

## Cenários de medição

O baseline deve medir, no mínimo:

| Cenário | Estado | Métrica principal |
|---|---|---|
| Startup frio | App fechado, sem cache | Tempo até o primeiro frame útil |
| Startup quente | App fechado, com cache | Tempo até o canvas restaurar |
| Idle | 1 terminal, sem agente | Memória, CPU, frame p95 |
| Pan | 20 nós, 5 terminais | Frame p95, long tasks, dropped frames |
| Pan extremo | 50 nós, 10 terminais | Frame p95, memória, contexto WebGL |
| Colapso | Colapsar e expandir 10 nós | Frame p95, long tasks |
| Digitação | Terminal com TUI pesada | Latência de input, frame p95 |
| Busca global | Workspace grande | Tempo de resposta, long tasks |
| Restauração | Workspace com 20 nós e 10 terminais | Tempo até interativo, memória |
| Background | App minimizado por 10 min | Memória, CPU, integridade do scrollback |

Cada cenário precisa de um roteiro repetível e de um número de baseline. Sem isso, não há como provar ganho.

## Métricas e metas

Metas iniciais, a validar com o baseline. Não são compromissos públicos.

| Métrica | Meta inicial | Racional |
|---|---|---|
| Startup frio até primeiro frame útil | abaixo de 2 s | Percepção de app nativo |
| Startup quente até canvas restaurado | abaixo de 1,5 s | Uso diário |
| Frame p95 no pan com 20 nós | abaixo de 16 ms | 60 fps estável |
| Frame p95 no pan com 50 nós | abaixo de 33 ms | 30 fps aceitável |
| Long tasks acima de 50 ms no pan | zero | Evitar travamento perceptível |
| Memória com 10 terminais | abaixo de 400 MB | Viável em máquina de 16 GB |
| Memória com 20 terminais | abaixo de 700 MB | Limite de trabalho pesado |
| Latência de input no terminal | abaixo de 50 ms | Sensação de resposta |
| Restauração de 20 nós e 10 terminais | abaixo de 5 s | Retomada rápida |
| Contextos WebGL ativos | abaixo do limite do Chromium | Evitar fallback silencioso |

## Atribuição de custo

O monitor atual diz que o frame está lento. O baseline precisa dizer por quê. O roteiro:

1. **Chrome tracing** com categorias de renderer, layout, paint, compositor e GPU.
2. **React Profiler** para commits longos e re-renders causados por estado.
3. **xterm stats** para escrita, parse e render por instância.
4. **Marcadores de performance** nos caminhos de pan, colapso, persistência e IPC.
5. **Amostragem de memória** por processo antes e depois de abrir terminais.
6. **Comparação de cenários**: com e sem efeitos visuais, com e sem terminais, com e sem plugins.

A saída é uma tabela de culpados por cenário. Só depois disso se escolhe o que otimizar.

## Plano de otimização

Ordem de ataque, do maior retorno para o menor:

1. **Caminho quente de input.** Tirar persistência, IPC e serialização do pan, do drag e da digitação.
2. **Contextos WebGL.** Garantir budget, fallback e destruição correta. Medir quantos terminais realmente precisam de WebGL.
3. **Culling e LOD no canvas.** Não renderizar o que não está visível e reduzir detalhe no zoom distante.
4. **Animações caras.** Migrar layout para transform e opacity. Evitar animar blur, sombra e filtro.
5. **Blur e backdrop-filter.** Reduzir área, usar camada pré-renderizada e desligar em movimento.
6. **Startup.** Carregar Monaco, plugins e settings sob demanda.
7. **Memória.** Limitar scrollback, liberar buffers, revisar retenção de sessões.

## Critérios de parada

- Se o profiling não apontar um culpado claro em duas semanas, parar e redefinir o escopo.
- Se uma otimização não mover a métrica do cenário em pelo menos 10%, reverter.
- Se a otimização quebrar um teste de contrato ou de geometria, tratar como regressão, não como custo aceitável.
- Se a meta exigir reescrever um subsistema inteiro, levar ao plano de fases, não fazer no impulso.

## O que não fazer

- Não otimizar por sensação.
- Não adicionar uma segunda stack de animação.
- Não aumentar o budget de WebGL sem medir o limite real.
- Não remover fallback de DOM do terminal.
- Não trocar o Electron por causa de frame rate sem antes provar que o Electron é o culpado.
