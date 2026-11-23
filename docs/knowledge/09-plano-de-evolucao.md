# Plano de evolução

## Princípios

1. **Construção primeiro.** O Glimpse ainda não é usado no dia a dia porque a orquestração não está pronta. O plano ativo termina essa feature antes de medir uso.
2. **Primeiro entender, depois mexer.** Inventário e medição valem para o que já é usado. Durante a construção, o critério é o pronto da feature, não o hábito.
3. **Uma entrega visível por onda.** Base sólida não pode virar desculpa para não entregar.
4. **Mudanças aditivas.** O fork precisa continuar recebendo updates do upstream.
5. **Número ou não entra.** Toda otimização tem baseline e critério. O orçamento de performance é portão de merge, não fase.
6. **Confiabilidade antes de estética.** Sessão e scrollback não podem regredir.
7. **Nada de big bang.** Fases curtas, com critério de parada.
8. **Merge é trabalho de agente.** O Bruno lê o relatório e decide só o que é classe B.

## Revisão de 2026-11-20

Três fatos mudaram o plano.

- O Glimpse está em construção. A feature de orquestração não está pronta e por isso ainda não entrou no uso diário. Medir uso agora mede o vazio.
- O merge com o upstream vira rotina semanal de agente, em três classes de risco. O custo deixa de ser medido em horas do Bruno.
- Os dados locais do OpenCove eram de teste e podem ser recriados. O bloqueio de schema é de numeração de migração, não de perda de histórico.

A Mesa de coordenação foi parkeada. O Bruno esclareceu que o Glimpse já coordena o trabalho entre projetos e agentes. A Mesa fica como ideia futura, não é fase.

## Visão de progressão

```
Semana 0: reconciliar, separar o banco, primeiro merge por agente
   |
Fase 1: concluir a orquestração (fase 2 e fase 3 da feature)
   |
Fase 2: primeiro uso real e medição de atrito
   |
Fase 3: suavização e caminho quente
   |
Fase 4: poda e gates
   |
Fase 5: features novas
```

A ordem é construção, uso, então polimento. Medição de uso só entra quando existe uso. Cada fase tem entregável, critério de saída e risco principal.

## Semana 0: reconciliação, schema e primeiro merge por agente

**Duração indicativa**: 1 semana.

**Objetivo**: remover os bloqueios de merge e provar o ciclo de merge por agente, para a construção continuar sobre a base atualizada.

**Entregáveis**:

- Banco único, versão 16, aplicado junto com o merge do upstream: o esquema 15 entra e a criação das tabelas de orquestração passa para `ensureCurrentSchema`, onde é idempotente. A separação do banco fica como opção futura, não como trabalho agora.
- Teste de migração a partir de um banco v14 do fork, com as tabelas de orquestração intactas, e de um banco já em 15 sem essas tabelas, que precisa ganhá-las. O banco de teste pode ser recriado, então o critério é correção, não preservação.
- Diagnóstico do merge concluído: upstream 141 commits à frente, 58 arquivos em conflito (12 mecânicos, 30 de área sensível, 16 complexos). O upstream não toca as tabelas de orquestração.
- Primeiro merge executado pelo agente `merge-upstream`, em branch descartável, com relatório de commits, conflitos, arquivos, portões, classe e tempo de agente.
- Mapa de divergências gerado a partir do diff real, não da memória.
- Backup automático antes de cada migração, como rede de segurança, não como bloqueio.
- Decisão sobre pasta de dados, nome do produto e atualizador adiada para a distribuição.

**Critério de saída**:

- O caminho escolhido passa no teste: um banco v14 migra para 16 com as tabelas de orquestração intactas, e um banco 15 sem elas passa a tê-las.
- Existe pelo menos um relatório de merge por agente, com cada conflito classificado. Se houver classe A, ela faz o merge sozinha; a classe B para e pede aprovação.
- Toda área divergente tem dono, motivo e decisão.

**Risco principal**: o agente classificar uma mudança de schema como mecânica e fazer merge sozinho. Mitigação: classificação por caminho, falha fechada, proteção de branch e caminho de reversão.

**Resultado (2026-11-21)**:

- Upstream `3e56ce3` integrado na branch `docs/orchestration-adr` pelo merge `b2e73520`, com o merge de reconciliação `a631e59e` e a correção de escopo `36527a3f`.
- 59 conflitos: 12 mecânicos, 47 de área sensível e 1 de segurança (lineage). 2.631 arquivos.
- Schema 16: as quatro tabelas de orquestração passam a ser criadas em `ensureCurrentSchema`, com migração testada de um banco 14 do fork e de um banco 15 sem elas. Banco único, sem separação.
- Carve-out de lineage: um grant só acessa, em projeto estrangeiro, o subtree que ele criou. Lista, leitura, atualização, criação filha e resolução mínima de espaço seguem essa regra; mutação de espaço alheio e criação solta continuam negadas.
- Portões: 49.223 testes de unidade, 2.409 de contrato de control surface, 27/27 de lineage, `arch:check` verde com 2.535 avisos congelados no baseline de 29 arquivos do fork, typecheck limpo e `build:cli` verde.
- Divergência assumida: o teste de lineage do upstream foi adaptado para negar `@parent` fora do subtree, por segurança.
- Pendente: rotina semanal de merge, instalação do `knip` no ambiente e os testes com chave real.

## Fase 1: concluir a orquestração

**Duração indicativa**: 4 a 6 semanas.

**Objetivo**: tornar a orquestração usável de ponta a ponta, no Codex e no opencode, com aprovação pela interface e sem intervenção manual no terminal.

**Método**:

- Corrigir primeiro os dois defeitos abertos de continuidade, I-02 e I-03, hoje marcados como falha esperada nos testes de integração. Eles são o critério de prontidão da fase 2, não dívida adiável.
- Fechar o restante do critério de pronto da fase 2 da feature, já escrito em `docs/architecture/ORCHESTRATION_RISKS_AND_TESTS.md`: unidade, contrato e integração verdes sem chave; testes nativos sob Electron; testes reais sem custo; correção do opencode v2; custo medido uma vez; hash de `~/.codex` e `~/.config/opencode` igual antes e depois; revisão independente sem achado bloqueante; `pnpm arch:test` e `pnpm verify:quick` verdes.
- Executar a fase 3 da feature, em `docs/architecture/ORCHESTRATION_PHASE2_CARDS.md`: adaptador opencode v2, conexão por conversa e por arrastar, aprovação de executor e hooks pela interface, e2e com executores mistos e conversa entre orquestradores.
- Cada card entra como PR curto e reversível, com o teste do invariante que ele toca. Sem renomeação em massa e sem refatoração estética durante o fechamento.
- O orçamento de performance existente continua como portão de merge, sem virar fase.

**Estado em 2026-11-21**:

- I-02 e I-03 corrigidos, revisados e commitados (`68628ba8`), com vermelho provado antes.
- Portões sem chave verdes: unidade de orquestração 445, contrato de control surface 324, integração de orquestração 168, nativo sob Electron 54, arch 28. O portão combinado dos dois cards fechou com 1.703 testes e zero falha.
- F3-01 (adaptador opencode v2) e F3-03 (aprovação pela interface) entregues, revisados e integrados. O catálogo tem 163 operações `schema`.
- F3-02a entregue e integrado (`afc10edb`): arrastar com confirmação, seta selecionável, desligar com e sem despacho em voo, conversa preservada. Inclui a correção do escopo do grant (`82f2ce38`) e a correção do fixture do Claude (`77ab3e33`).
- Pendente: F3-02b1 (pedido por conversa, TTL de 30 minutos), F3-04, testes com chave real, custo medido uma vez e o E2E de plugins, que falha no HEAD limpo.

**Entregáveis**:

- Feature de orquestração fechada no critério de pronto da fase 2.
- Fase 3 da feature entregue, com aprovação pela interface.
- Uma tarefa real de ponta a ponta: um orquestrador, dois executores, um deles opencode, sem tocar no terminal do app.
- Registro dos defeitos encontrados no uso, priorizados por gravidade de continuidade.

**Critério de saída**:

- Todos os itens do critério de pronto da fase 2 estão verdes, com a evidência no relatório.
- O Bruno executa a tarefa real de ponta a ponta sem intervenção manual e sem perder despacho, aviso ou scrollback.
- Nenhuma pendência bloqueante de revisão em aberto.

**Risco principal**: a feature crescer durante o fechamento e nunca ficar pronta. Mitigação: escopo congelado nos cards existentes, feature nova só depois do critério de saída, e um portão de revisão por card.

## Fase 2: primeiro uso real e medição de atrito

**Duração indicativa**: 2 a 3 semanas, incluindo uma a duas semanas de uso.

**Objetivo**: usar a orquestração todos os dias e descobrir onde o uso real dói, agora com uso de verdade.

**Método**:

- Registro local de uso por uma ou duas semanas, sem telemetria e sem conteúdo de terminal: telas, ações, projetos e esperas.
- Medir os cenários reais na máquina do Bruno: abrir, trocar de projeto, arrastar e zoom, terminal com saída longa, restaurar sessão e despachar trabalho.
- Cruzar os números com uma lista datada dos três momentos em que ele reclama ou espera.
- Escolher um único culpado medido, corrigir, medir de novo. Sem culpado claro, a fase não avança.
- Rodar a suíte `tests/perf` no mesmo cenário e na mesma máquina, com hardware, GPU e frequência de tela registrados.

**Entregáveis**:

- Inventário curto de uso: cinco áreas mais usadas e cinco menos usadas.
- Atribuição de custo por cenário: React, CSS, xterm, IPC, persistência e GPU.
- Lista datada de atritos, com um culpado escolhido.
- Um primeiro ganho visível, com antes e depois.
- Lista de candidatos a poda, para a Fase 4.

**Critério de saída**:

- Todo cenário crítico tem número de baseline.
- O primeiro ganho tem antes, depois e critério de sucesso.
- O dono reconhece o mapa de uso como correto.
- A lista de poda tem dono e motivo.

**Risco principal**: o inventário virar documentação morta. Mitigação: cada área termina em uma decisão, e a fase só fecha com um ganho entregue.

## Fase 3: suavização e caminho quente

**Duração indicativa**: 4 a 6 semanas.

**Objetivo**: melhorar o que o dono percebe todos os dias, sem reescrever a UI.

**Método**:

- Micro-interações com tokens CSS: hover, press, foco, abrir e fechar painel, com um tempo e uma curva só. Apenas movimento e opacidade, sem sombra, desfoque ou mudança de layout.
- Lib pequena só para entrada, saída e colapso, com respeito a movimento reduzido.
- No caminho mais usado, corrigir o maior culpado medido: trabalho repetido na interface, gravação a cada quadro, conversa demais entre camadas ou efeito visual pesado.
- Repetir a medição no mesmo cenário e na mesma máquina. Se não mover 10%, reverter. Se quebrar terminal ou sessão, parar.
- Uma correção por vez, curta e reversível, sem reescrever canvas ou terminal.

**Entregáveis**:

- Tokens de motion em CSS.
- Lib de motion apenas para presença e springs, com wrapper e reduced motion.
- Onda 1 de migração: hover, press e foco em CSS; colapso de nó com spring se necessário.
- Uma animação emblemática entregue e percebida.
- Remoção de trabalho pesado do caminho de input: persistência, IPC e serialização.
- Budget e fallback de WebGL revisados.
- Metas de frame p95 e long tasks medidas antes e depois.

**Critério de saída**:

- Frame p95 no pan com 20 nós abaixo de 16 ms, ou ganho documentado.
- Zero long tasks acima de 50 ms no pan.
- Nenhuma animação de layout, blur ou sombra na onda 1.
- Nenhuma regressão de terminal ou scrollback.

**Risco principal**: mexer no caminho quente e quebrar durabilidade. Mitigação: testes de contrato e recuperação.

## Fase 4: poda e gates

**Duração indicativa**: 2 a 3 semanas.

**Objetivo**: reduzir gordura e criar barreiras contra regressão, com o inventário da Fase 2.

**Entregáveis**:

- Remoção de dependências sem uso, com verificação.
- Remoção de código morto, em PRs pequenos e reversíveis.
- `FORK.md` com o mapa de divergências e regras de merge.
- Gates: limite de linhas por arquivo, orçamento de performance no CI, checagem de dependências.
- Documentação de como rodar o baseline.

**Critério de saída**:

- Build e testes passam.
- Nenhuma dependência removida é usada indiretamente.
- O CI falha se o orçamento de performance estourar.
- O mapa de divergências está atualizado.

**Risco principal**: conflito com upstream. Mitigação: PRs pequenos, sem renomeações em massa, sem mudança de CSS global.

## Fase 5: features novas

**Duração**: contínua.

**Objetivo**: voltar a construir produto com base estável e com uso real medido.

**Regras**:

- Toda feature nova usa os tokens de motion.
- Toda feature nova tem teste de contrato.
- Toda feature nova declara impacto de performance.
- Toda feature nova declara custo de divergência do upstream.
- Feature que não fortalece um princípio de produto entra na fila, não no roadmap.

**Candidatas**:

- Diff viewer, se o fluxo de git e PR justificar.
- Melhorias de retomada e confiabilidade.
- Melhorias de legibilidade de estado de agente.
- Redução de opções de settings sem uso.
- Presets de workspace.

Ideias fora do plano ativo ficam em `17-ideias-futuras.md`. A Mesa de coordenação está lá.

## Cronograma indicativo

| Fase | Semanas | Entrega visível |
|---|---:|---|
| Semana 0 | 1 | Banco separado e primeiro merge por agente |
| Fase 1 | 4 a 6 | Orquestração usável de ponta a ponta |
| Fase 2 | 2 a 3 | Uso diário e um ganho medido |
| Fase 3 | 4 a 6 | Animações melhores e pan mais estável |
| Fase 4 | 2 a 3 | App mais leve e CI com orçamento |
| Fase 5 | contínua | Features novas |

O cronograma é uma hipótese. O critério de saída importa mais que a data.

## O que não fazer

- Não medir uso de um produto que ainda não está em uso.
- Não reescrever a UI em outra stack.
- Não refatorar o canvas inteiro.
- Não trocar o emulador de terminal.
- Não remover a plataforma de plugins.
- Não adicionar uma segunda stack de animação.
- Não otimizar sem baseline.
- Não fazer PR transversal que inviabilize o merge com upstream.
- Não construir uma segunda camada de coordenação enquanto o Glimpse der conta.
- Não deixar merge de schema, contrato ou terminal sem portão.
- Não medir merge em horas do Bruno.

## Como medir progresso

- Itens do critério de pronto da fase 2 da orquestração, verdes por card.
- Tarefas reais concluídas de ponta a ponta sem intervenção manual.
- Número de regressões de sessão, aviso e scrollback.
- Conflitos por merge, tempo de portão e correções duplicadas.
- Números de baseline repetidos a cada fase, depois do primeiro uso real.
- Número de animações migradas para compositor.
- Número de dependências e linhas removidas.
- Tempo de startup e memória com 10 terminais.
- Percepção do dono no uso diário.

## Critérios de abortar ou replanejar

- Se a Fase 1 não fechar o critério de pronto, congelar escopo novo até fechar.
- Se a classe A causar um incidente de schema, suspender o auto-merge e revisar a classificação.
- Se a migração do banco não puder ser separada, congelar schema e reconciliar manualmente antes de qualquer merge.
- Se a Fase 2 não produzir um culpado claro, não abrir a Fase 3.
- Se a Fase 3 não mover métrica em 10%, reverter e replanejar.
- Se a Fase 4 gerar conflito constante com upstream, reduzir escopo.
- Se a confiabilidade regredir, parar features e corrigir.
- Se a coordenação entre projetos voltar a doer, retomar a Mesa pela ideia futura, não pelo plano ativo.
