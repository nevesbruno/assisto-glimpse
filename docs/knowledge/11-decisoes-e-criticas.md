# Decisões e críticas

## Decisões firmes

### D001: Electron é a base

- **Data**: 2026-11-13.
- **Contexto**: avaliação de reescrita em Rune.
- **Decisão**: manter Electron, React e a arquitetura atual.
- **Motivo**: custo de reescrita de 52 a 76 pessoa-mês, perda de terminal, plugins e Web UI.
- **Consequência**: foco em otimização e sistema de motion.
- **Revisão**: a cada 6 ou 12 meses.

### D002: Rune não é runtime nem motor

- **Data**: 2026-11-13.
- **Contexto**: ideia de usar Rune como motor de animação ou render embutido.
- **Decisão**: não usar. O headless é ferramenta de teste e gravação, não API de frames.
- **Motivo**: sem superfície compartilhada, sem webview, sem releases. Integração exigiria streaming de frames ou janela sobreposta.
- **Consequência**: usar o modelo de motion do Rune como referência conceitual.

### D003: Performance com número

- **Data**: 2026-11-13.
- **Contexto**: insatisfação com o peso do Electron.
- **Decisão**: toda otimização tem baseline, cenário e critério. Sem número, não entra.
- **Motivo**: o case study de jitter mostra que a causa era arquitetural, não a stack.
- **Consequência**: O inventário é atribuição de custo, não só baseline.

### D004: Fork aditivo e compatível com upstream

- **Data**: 2026-11-13.
- **Contexto**: o fork quer continuar recebendo updates.
- **Decisão**: mudanças pequenas, aditivas, com feature flags e testes de contrato.
- **Motivo**: refatorações transversais inviabilizam merge.
- **Consequência**: poda incremental, motion como camada, `FORK.md` com mapa de divergências.

### D005: Motion em duas camadas

- **Data**: 2026-11-13, revisada em 2026-11-14.
- **Contexto**: 40 animações artesanais definidas em 23 arquivos, com 75 usos.
- **Decisão**: tokens CSS para hover, press, foco e transições declarativas. Lib só para presença e springs com retomada de velocidade. Motor próprio só se a lib falhar em caso concreto.
- **Motivo**: evitar overengineering, preservar temas de plugin e reduzir conflito com upstream.
- **Consequência**: a Fase 1 fica menor e mais compatível.

### D006: Inventário antes de features

- **Data**: 2026-11-13.
- **Contexto**: o dono não conhece todas as funcionalidades do fork.
- **Decisão**: inventário funcional e de uso antes de qualquer feature nova.
- **Motivo**: não dá para priorizar o que não se conhece.
- **Consequência**: O inventário entrega mapa do produto e baseline.

### D007: Resolver a colisão de schema antes de qualquer fase

- **Data**: 2026-11-14.
- **Contexto**: o fork está na versão 14 do banco; o upstream está na 15.
- **Decisão**: congelar schema, renumerar ou isolar tabelas próprias e testar a migração antes de qualquer merge.
- **Motivo**: risco de a migração rodar errada e o merge parar. A perda de dados locais deixou de ser o risco principal (ver D012).
- **Consequência**: a Semana 0 precede a Fase 1.

### D008: Merge de reconciliação e merge semanal

- **Data**: 2026-11-14.
- **Contexto**: o upstream avança cerca de 16 commits por dia.
- **Decisão**: fazer um merge de teste agora e manter merge semanal.
- **Motivo**: medir o custo real e evitar divergência acumulada.
- **Consequência**: a cadência semanal continua, mas a execução passa a ser do agente (ver D011).

### D009: Tokens CSS primeiro, lib só para presença e springs

- **Data**: 2026-11-14.
- **Contexto**: a proposta de adotar Motion para hover, press e foco contradiz a regra de não ter segunda stack.
- **Decisão**: hover, press e foco usam tokens CSS. Lib só para presença e springs com retomada de velocidade.
- **Motivo**: preservar temas de plugin, reduzir conflito com upstream e evitar JavaScript desnecessário.
- **Consequência**: a Fase 1 fica menor e mais compatível.

### D010: Não recomeçar do zero

- **Data**: 2026-11-14.
- **Contexto**: pergunta sobre abandonar o fork e começar um projeto novo.
- **Decisão**: não recomeçar. Manter o upstream e testar a orquestração fora do núcleo.
- **Motivo**: recomeçar perde a parte mais cara e mais confiável do sistema, que é terminal, sessão, canvas e recuperação.
- **Consequência**: a Semana 0 e o teste de duas semanas da orquestração como serviço vizinho entram no plano.

### D011: Merge com upstream é trabalho de agente

- **Data**: 2026-11-20.
- **Contexto**: o Bruno delegou os merges. A pergunta de tempo semanal dele não existe mais.
- **Decisão**: rotina semanal de agente com três classes. Classe A, conflito mecânico sem schema, contrato, terminal ou persistência, faz o merge sozinha. Classe B, toca área sensível, fica retida para aprovação. Classe C, conflito ou portão falhando duas vezes, para e entrega diagnóstico.
- **Motivo**: merge é trabalho mecânico e repetitivo. O humano decide só o que é sensível ou irreversível.
- **Consequência**: a métrica passa a ser conflitos, arquivos, tempo de portão, tempo de agente e correções duplicadas. A Semana 0 prova o ciclo.

### D012: Dados locais são recriáveis

- **Data**: 2026-11-20.
- **Contexto**: a instalação do OpenCove era de teste e o perfil local é `opencove-dev`.
- **Decisão**: tratar a perda de dados locais como custo baixo. O portão que resta é a numeração da migração.
- **Motivo**: não há histórico de produção a preservar no banco de teste.
- **Consequência**: o backup continua como rede de segurança, mas deixa de bloquear a Semana 0. A D007 continua valendo como portão técnico.

### D013: Mesa de coordenação é candidata à Fase 1

- **Data**: 2026-11-20.
- **Contexto**: a dor declarada é coordenar vários projetos em paralelo, com vários agentes por projeto.
- **Decisão**: a próxima peça é a Mesa, mas a Fase 1 só começa depois do spike da interface de controle. O MVP é somente leitura, com as visões Agora, Projetos, Fila e Upstream.
- **Motivo**: a dor é de leitura e decisão, não de animação. O canvas mostra o espaço; falta a camada de portfólio.
- **Consequência**: o plano ganha um portão antes da Fase 1. O protótipo vive em `docs/knowledge/coordenacao/`. Se a interface pública não bastar, a Mesa espera as operações novas ou vira view no renderer como exceção documentada.
- **Status**: substituída pela D016.

### D014: Spike antes de comprometer a Mesa

- **Data**: 2026-11-20.
- **Contexto**: o Bruno pediu spike primeiro, depois do protótipo.
- **Decisão**: executar o spike externo da interface de controle e só então comprometer a Mesa como Fase 1.
- **Motivo**: provar dados, ações e autorização fora do núcleo antes de pagar divergência ou UI.
- **Consequência**: a Fase 1 fica condicionada ao veredito. Se a interface não expuser atenção e fila, a decisão seguinte é adicionar operações públicas ou voltar ao renderer.
- **Status**: substituída pela D016.

### D015: Operações públicas antes do MVP da Mesa

- **Data**: 2026-11-20.
- **Contexto**: o spike provou que a Mesa cabe fora do núcleo, mas atenção só tem contagens, aprovar e hooks exigem bearer admin, e fila e custo não existem.
- **Decisão**: antes do MVP, entregar `orch.attention.list` e `orch.run.get` como leitura e definir um grant de orquestração com escopo mínimo. A fila de trabalho (`orch.work`) fica para uma decisão separada.
- **Motivo**: sem ids de atenção a caixa não funciona; sem grant a única saída é entregar o token admin do desktop à Mesa.
- **Consequência**: a Fase 1 começa por um PR aditivo no control surface, não pela UI. O probe deve ser repetido com um link ativo e uma aprovação pendente.
- **Status**: substituída pela D016.

### D016: Mesa fica como ideia futura

- **Data**: 2026-11-20.
- **Contexto**: o Bruno esclareceu que o Glimpse já coordena o trabalho entre projetos e agentes; a Mesa não era o que ele pediu.
- **Decisão**: parar o trabalho na Mesa e guardá-la como ideia futura. O plano ativo volta para reconciliação, medição, performance, motion e poda.
- **Motivo**: não faz sentido construir uma segunda camada de coordenação para uma dor que o produto já resolve.
- **Consequência**: o protótipo, o spec e o spike ficam em `docs/knowledge/` como referência, sem gate nem fase. A ideia volta se a coordenação do Glimpse deixar de dar conta. Substitui D013, D014 e D015.

### D017: Construção antes de medição de uso

- **Data**: 2026-11-20.
- **Contexto**: o Bruno esclareceu que ainda não usa o Glimpse no dia a dia porque a feature de orquestração não está pronta. O produto está em construção.
- **Decisão**: o plano ativo termina a orquestração antes de qualquer medição de uso. A Fase 1 passa a ser concluir a orquestração; a medição de uso vira Fase 2, depois do primeiro uso real.
- **Motivo**: medir uso de um produto que ainda não entrou em uso mede o vazio. A dor atual é a feature incompleta, não a fluidez percebida.
- **Consequência**: o orçamento de performance existente continua como portão de merge, não como fase. A Semana 0 fica mantida como primeiro passo, para a construção continuar sobre a base atualizada.

### D018: Um banco, schema 16 e criação idempotente das tabelas

- **Data**: 2026-11-20.
- **Contexto**: o diagnóstico do upstream encontrou 141 commits à frente e 58 arquivos em conflito (12 mecânicos, 30 de área sensível, 16 complexos). O schema 15 do upstream é aditivo e idempotente em `ensureCurrentSchema` e não toca `agent_links`, `orchestration_dispatches`, `orchestration_notices` nem `orchestration_hook_approvals`.
- **Problema**: o merge limpo mantém `createOrchestrationTables` dentro de `createTables`, que só roda em banco novo ou v1. Um banco já em 15 nunca ganharia as tabelas de orquestração. O guard de downgrade também rejeita um banco 15 aberto por um fork em 14.
- **Decisão**: manter um banco único, subir a versão para 16 no merge e mover a criação das tabelas de orquestração para `ensureCurrentSchema`. Não separar o banco agora.
- **Motivo**: os 4 pontos de composição compartilham o mesmo `opencove.db` e a orquestração já abre segunda conexão nesse arquivo. Separar duplicaria composição, migração e transporte remoto sem ganho imediato.
- **Consequência**: o merge do upstream vira aditivo e testável. A separação do banco fica como opção futura, se a colisão de schema voltar.

### D019: Adaptador opencode e aprovação pela interface

- **Data**: 2026-11-21.
- **Contexto**: F3-01 e F3-03 foram implementados e revisados. O portão combinado fechou com 1.703 testes verdes, 163 operações de control surface e nenhuma falha.
- **Decisão**: o órfão do opencode é identificado por pid e linha de comando, sem persistência nova, e nunca é morto em ambiguidade. A atenção vem da consulta `orch.approval.list` mais o evento existente, sem gravar o resumo do comando no SQLite. A superfície é o Control Center com janela própria, e as ações ficam habilitadas com o executor em `busy`, desabilitadas só em `starting` e `unavailable`.
- **Motivo**: manter o resumo de comando fora do estado sincronizado, não criar um segundo caminho de escrita de aprovação e não bloquear o fluxo normal, em que a aprovação chega durante o turno.
- **Consequência**: F3-01 e F3-03 estão integrados. Ficam pendentes os testes com chave real, o custo e os e2e de aprovação e hook com Codex real. Um hook aprovado usa o `currentHash` do momento do clique, então mudança de hash entre leitura e clique é risco registrado.

### D020: Carve-out de lineage para grants

- **Data**: 2026-11-21.
- **Contexto**: o upstream passou a testar acesso de um grant a nós que ele criou em outro projeto. O fork confinava todo grant ao próprio projeto desde `5932c1ae`. A revisão do merge achou quatro vazamentos na primeira tentativa de conciliação.
- **Decisão**: um grant acessa, em projeto estrangeiro, apenas o subtree de lineage que ele criou, por ID explícito. Lista exige criador no subtree; leitura, atualização, criação filha e `agent.get` seguem a mesma regra; `space.update` estrangeiro continua negado; criação solta e `near` fora do subtree também. Lista por `@parent` fora do subtree devolve vazio.
- **Motivo**: preservar a coordenação entre projetos sem devolver ao grant o poder de ler, listar ou mutar conteúdo alheio. A alternativa de confinamento total descartaria a feature do upstream e criaria divergência em cada merge.
- **Consequência**: o teste de lineage do upstream foi adaptado com comentário de divergência. O `arch:check` congelou 2.535 avisos em 29 arquivos do fork no baseline. O carve-out tem teste negativo para cada vazamento encontrado.

### D021: F3-02a entregue e o pedido por conversa

- **Data**: 2026-11-21.
- **Contexto**: o arrastar para ligar, a seta selecionável e o desligar com confirmação foram entregues no F3-02a. O pedido por conversa ficou para o F3-02b1, com o risco R16 de texto injetado. O ADR L5 dizia pedido sem prazo; o Bruno pediu TTL.
- **Decisão**: o pedido nasce `requested` e só o clique do usuário o torna `active`. O TTL é de 30 minutos, checado pelo Worker na resposta e na leitura, com varredura no boot. O cartão vive na janela de aprovações, lendo o espelho, sem consulta nova. O peer fica para o F3-05. A correção do escopo do grant (`82f2ce38`) e o fixture do Claude (`77ab3e33`) entram junto.
- **Motivo**: sem TTL, um pedido antigo pode ser aprovado quando o contexto já mudou. O TTL não muda o R16: o clique do usuário continua obrigatório.
- **Consequência**: o F3-02a está integrado. O F3-02b1 começa pelo backend do pedido e do TTL, depois o cartão na interface. O E2E de plugins segue vermelho no HEAD limpo e fica como problema aberto.

## Críticas ao próprio plano

Estas críticas foram feitas depois da primeira versão da análise. Elas mudaram o plano.

### Crítica 1: a premissa do gargalo não estava medida

- A análise assumiu que o custo estava nas animações, sem atribuição por causa.
- O monitor mede sintomas, não separa CSS, React Flow, xterm e IPC.
- Se o culpado for outro, o motion system é otimização de vaidade.
- **Mudança**: O inventário virou atribuição de custo, não só baseline.

### Crítica 2: o programa de base podia virar fuga

- Inventário, motion, poda e gates somavam meses sem entrega visível.
- "Motor próprio" era overengineering.
- Faltava critério de parada.
- **Mudança**: lib e tokens primeiro, uma entrega visível por onda, critério de abortar.

### Crítica 3: o fork não foi tratado como restrição de primeira classe

- Refatorar 172 mil linhas e podar dependências compromete os updates do upstream.
- `FORK.md` documenta, não previne conflito.
- **Mudança**: estratégia de fork antes da poda, mudanças aditivas, PRs curtos, testes de contrato.

### Crítica externa (Opus 5.5)

Uma revisão adversarial independente encontrou pontos que as três críticas anteriores não cobriram:

- **Colisão de schema.** O fork declara versão 14; o upstream declara 15. As tabelas próprias de orquestração podem ocupar a mesma versão que a migração de retomada de sessão do upstream. É um bloqueio de migração, não um detalhe. Os dados locais são de teste e podem ser recriados.
- **O fork já não é aditivo.** Em seis dias, o fork somou 47 commits, 181 arquivos e 12,8 mil linhas, enquanto o upstream avançou 99 commits. A intenção aditiva não corresponde ao estado atual.
- **Motion contraditório.** Dizer "não adicionar segunda stack" e adotar Motion é contraditório. Tokens CSS devem cobrir hover, press e foco; lib só para presença e springs.
- **Contagem de animações errada.** São 40 definições em 23 arquivos, com 75 usos, não 75 animações.
- **Metas de frame mal definidas.** p95 abaixo de 16 ms é frouxo em 120 Hz e impossível de interpretar sem vsync. O critério "ou ganho documentado" não reprova nada.
- **Suíte de performance ignorada.** O repositório já tem `tests/perf` com cenários de canvas. O baseline deve usá-la.
- **Poda arriscada.** Tailwind está ativo no build. Remover dependência sem verificar o empacotador gera conflito e pode quebrar o CSS.

Esses pontos foram incorporados ao plano. Os que dependem de decisão do Bruno continuam abertos.

## Limitações da análise

- A estimativa de 52 a 76 pessoa-mês é de ordem de grandeza, não um orçamento.
- O inventário ainda não foi feito. As áreas e os números são um retrato do código, não do uso.
- O dono do produto ainda não validou o mapa de features.
- O baseline de performance ainda não foi medido.
- O custo real de manter o fork com upstream não foi medido.

## Decisões abertas

| Pergunta | Prazo | Critério |
|---|---|---|
| Qual lib de motion usar | Fase 3 | Cobertura de springs, presença, reduced motion e tamanho |
| Website nodes ficam ou saem | Fase 2 | Uso real e custo de manutenção |
| Orchestration tem uso real | Fase 2 | Uso diário ou código morto |
| Plugins são diferencial | Fase 2 | Uso real e custo de segurança |
| Web UI é produto ou emergência | Fase 2 | Uso real e custo de manutenção |
| Qual meta de memória | Fase 2 | Baseline medido |
| Revisar Rune quando | 6 ou 12 meses | Release estável, webview, terminal, updater |

## Como registrar uma decisão nova

Toda decisão relevante entra aqui com:

- ID e data.
- Contexto.
- Decisão.
- Motivo.
- Consequência.
- Critério de revisão.

Decisão sem consequência é intenção. Decisão sem critério de revisão é dogma.

## O que não é decisão

- Ideia em conversa.
- Hipótese sem medição.
- Preferência estética sem princípio.
- Vontade de experimentar tecnologia nova.

Essas coisas entram na fila de ideias, não no log de decisões.
