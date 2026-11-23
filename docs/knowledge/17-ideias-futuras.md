# Ideias futuras

Ideias boas que não são o foco agora. Ficam aqui para não se perderem e para não contaminarem o plano ativo.

## Mesa de coordenação

**Status**: parkeada em 2026-11-20. Não é fase, não é gate e não tem trabalho ativo.

**O que é**: uma tela única com os projetos, os agentes de cada projeto, a fila do que vem depois e uma caixa do que precisa do Bruno. A ideia era complementar o canvas com uma visão de portfólio.

**Por que ficou para depois**: o Bruno esclareceu que o Glimpse já coordena o trabalho entre projetos e agentes no uso diário. A dor que a Mesa resolveria não existe hoje. Construir uma segunda camada seria resolver um problema já resolvido.

**O que existe**:

- Protótipo navegável em `coordenacao/index.html`, com dados de exemplo.
- Spec, modelo, MVP e críticas em `16-mesa-de-coordenacao.md`.
- Spike da interface de controle em `spike-controle/`, com o que o app expõe e o que falta.

**O que o spike ensinou** (útil para qualquer cliente externo futuro):

- Projetos, links e estado dos agentes são legíveis fora do app.
- As decisões pendentes aparecem só como contagem, sem identificar o pedido.
- Aprovar fora do app exige a permissão máxima do desktop, o que é poder demais para um painel.
- Fila de trabalhos e custo por execução não existem como dados públicos.

**Quando revisitar**:

- Se a coordenação entre projetos voltar a doer no uso diário.
- Se o Glimpse ganhar uma forma segura de listar e responder decisões.
- Se houver um modelo de trabalho com prioridade e dependência.
- Depois que a base estiver estável e o fork em dia.

**O que não fazer**: não começar pela tela. A tela é a parte fácil. O pré-requisito é o dado e a permissão.

## Outras ideias

- Diff viewer no canvas, se o fluxo de git e PR justificar.
- Presets de workspace.
- Melhorias de legibilidade do estado de agente.
- Redução de opções de settings sem uso.

Estas ideias entram no roadmap só quando a base estiver estável e o upstream em dia.
