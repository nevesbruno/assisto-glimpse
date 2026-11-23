# Produto

## O que é o Glimpse

O Glimpse é um fork pessoal do OpenCove, um workspace espacial para desenvolvimento com agentes de código. Ele coloca terminais, sessões de agentes, tarefas, notas, documentos, imagens e sites num canvas infinito. A ideia central é que o contexto de trabalho seja espacial, não uma pilha de abas e chats lineares.

O produto se posiciona entre três categorias:

- **Terminal multiplexado**: vários PTYs, agentes e shells no mesmo lugar.
- **Workspace visual**: canvas com nós, regiões, conexões e persistência de layout.
- **Camada de orquestração**: tarefas, sessões, worktrees e providers de agente.

Ele não é uma IDE completa, não é um chat e não é um terminal puro. O diferencial é a organização espacial do trabalho paralelo.

## Origem e estado

- Fork de `DeadWaveWave/opencove`, versão 0.4.0, em alpha.
- Workspace: `/home/bruno/lab/assisto-network/glimpse`.
- Remote do fork: `git@github.com:nevesbruno/assisto-glimpse.git`.
- HEAD do levantamento: `9e1fe4c7`, em 2026-11-13.
- O fork tem commits próprios, incluindo trabalho em agentes, orquestração e MCP.
- O upstream continua ativo, com PRs e releases. O fork quer continuar recebendo updates.

## A dor que resolve

O dono do fork trabalha com muitos agentes, terminais, tarefas e notas ao mesmo tempo. A dor não é executar um comando. É lembrar onde cada coisa está, retomar contexto depois de uma interrupção e enxergar o estado do trabalho paralelo sem abrir dez janelas.

O Glimpse ataca essa dor em quatro frentes:

1. **Contexto visível**: o estado do trabalho fica no canvas, não escondido em abas.
2. **Retomada**: layout, viewport, scrollback e sessões sobrevivem a reinícios.
3. **Paralelismo**: vários agentes e terminais no mesmo espaço, com estados visíveis.
4. **Organização**: Spaces, worktrees, regiões e arquivos delimitam o trabalho.

## Princípios de produto

Estes princípios servem para filtrar ideias novas. Uma ideia que não fortalece nenhum deles entra na fila, não no roadmap.

1. **O contexto é espacial.** A posição e a vizinhança dos objetos carregam significado.
2. **O estado do agente é legível de longe.** Dá para saber quem trabalha, quem espera e quem falhou sem abrir cada nó.
3. **Retomar é mais importante que começar.** A qualidade do produto é medida pelo tempo que leva para voltar ao trabalho.
4. **Confiabilidade vem antes de beleza.** Perder scrollback ou sessão destrói a confiança mais rápido do que uma animação travada.
5. **A interface é ferramenta, não demo.** Microinteração existe para informar estado, não para exibir virtuosismo.
6. **Extensível sem rebuild.** Plugins e temas são parte do produto, não um extra.

## Usuário principal

O usuário principal é o próprio dono do fork, em uso diário e intenso. Isso tem consequências:

- A opinião dele é o critério final de utilidade.
- O produto pode ser opinativo, não precisa agradar todos os fluxos.
- A tolerância a regressão é baixa, porque a ferramenta é usada para trabalhar.
- A velocidade de iteração importa mais que a perfeição arquitetural.
- O produto precisa sobreviver a sessões longas, suspensão, troca de projeto e atualização.

## O que o produto já faz

O levantamento de 2026-11-13 encontrou:

- Canvas infinito com pan, zoom, trackpad, seleção, colagem, snapping e minimapa.
- Dez tipos de nó: terminal, agente, tarefa, nota, papel, imagem, documento, pasta, site e plugin.
- Terminais com xterm 6, WebGL, ligaduras, busca, unicode11, links e serialização.
- Agentes com Claude Code, Codex e providers configuráveis.
- Sessões de agente com retomada, transcripts, permissões e MCP.
- Orquestração com papéis, filas e execução paralela.
- Spaces, worktrees, arquivos e mounts.
- Plugins instaláveis com views HTML, comandos, skills, temas e backend Node.
- Temas, aparência pixel, efeitos de canvas e respeito a reduced motion.
- Command Center, Control Center, Agent Island, busca global e notificações.
- Worker com Web UI acessível por navegador.
- Monitor de performance embutido e relatório de diagnóstico.
- Atualização automática e releases.

## O que o produto não é

- Não é um editor de código completo. Monaco cobre documentos, mas não há diff viewer implementado.
- Não é um chat. A conversa com agentes acontece no terminal.
- Não é um gerenciador de tarefas genérico. As tarefas existem para organizar trabalho de agente.
- Não é uma plataforma de plugins de terceiros com sandbox de segurança maduro. Plugins rodam com confiança local.

## Métricas de sucesso

O produto precisa de métricas próprias, não só de frame rate.

| Dimensão | Métrica | Meta inicial |
|---|---|---|
| Retomada | Tempo entre abrir o app e voltar ao contexto anterior | abaixo de 10 s |
| Estabilidade | Sessões perdidas por semana | zero |
| Desempenho | Frame p95 durante pan com 20 nós | abaixo de 16 ms |
| Memória | Uso com 10 terminais abertos | abaixo de 400 MB |
| Clareza | Tempo para identificar um agente esperando | abaixo de 3 s |
| Extensibilidade | Instalar e ativar um plugin sem rebuild | abaixo de 1 min |

As metas são hipóteses iniciais. O inventário substitui por números medidos.

## Perguntas abertas

- Qual é o fluxo diário real do dono? Quais nós ele usa todos os dias e quais nunca abriu?
- O produto precisa de colaboração multiusuário ou o escopo é pessoal?
- O Web UI é parte do produto ou apenas um modo de emergência?
- Plugins são um diferencial ou um custo de manutenção?
- Qual é o limite aceitável de memória para 20 terminais?
- O produto deve continuar opinativo ou abrir espaço para presets e fluxos de terceiros?

Estas perguntas devem ser respondidas no inventário, não por intuição.
