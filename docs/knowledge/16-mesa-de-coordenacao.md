# Mesa de coordenação

> **Status: ideia futura, parkeada em 2026-11-20. Não faz parte do plano ativo.**
> O Bruno esclareceu que o Glimpse já coordena o trabalho entre projetos e agentes hoje. O material fica como referência para quando a coordenação voltar a doer. O plano ativo está em `09-plano-de-evolucao.md`.

## A dor

Hoje o estado do trabalho mora em três lugares. O canvas mostra onde os agentes vivem, o terminal mostra o que cada um diz, e as notificações mostram o que precisa de decisão. Com vários projetos e vários agentes por projeto, não existe uma resposta única para quatro perguntas: o que está rodando, o que está na fila, o que está bloqueado e o que precisa de mim.

O custo aparece no uso diário. Trocar de projeto exige reconstruir o contexto na cabeça. Descobrir o que travou exige abrir terminais. Decidir o que fazer agora exige ler notificações espalhadas. A dor não é falta de features. É falta de uma camada de leitura e decisão.

## A decisão

A hipótese era uma Mesa de coordenação, se o spike da interface de controle provasse que ela cabia fora do núcleo. Ela lê e decide; não edita o espaço. O canvas continua sendo o lugar do trabalho espacial. A Mesa seria o lugar do portfólio.

O protótipo existe para alinhar a leitura. O spike de 2026-11-20 mediu o que o app expõe e o que falta; o resultado está em `spike-controle/relatorio.md`.

Ela responde quatro perguntas em menos de dez segundos e transforma o resto em fila e atenção. Não tenta substituir o canvas, o terminal ou o editor.

## Modelo

| Conceito | O que é | Onde vive |
|---|---|---|
| Projeto | Unidade de isolamento, com grant, branch, saúde e limite de trabalho em andamento | Workspace |
| Trabalho | Unidade de valor, com critério de aceite, prioridade e dependências | Orquestração |
| Execução | Uma tentativa de um agente sobre um trabalho | Executor |
| Evento | Mudança de estado, mensagem, aprovação, conflito ou conclusão | Registro append-only |
| Atenção | Fila derivada do que exige decisão humana | Derivada de eventos |
| Fila | Trabalhos prontos para despacho, com agente sugerido | Orquestração |

Estados de execução: fila, executando, aguardando, revisão, bloqueada, concluída, falhou, cancelada.

## Invariantes

1. Um trabalho tem no máximo uma execução ativa.
2. Nenhuma execução cruza projetos sem grant explícito.
3. O estado exibido vem do último evento confirmado, não de otimismo da interface.
4. Aprovação humana existe só para o que é irreversível, sensível, cruzado ou indefinido.
5. O limite de trabalho em andamento por projeto é respeitado antes do despacho.
6. Todo item de atenção tem dono, idade e ação padrão.

## As quatro visões

| Visão | Pergunta | O que mostra |
|---|---|---|
| Agora | O que está acontecendo e o que precisa de mim? | Execuções por projeto, caixa de atenção e saúde do upstream |
| Projetos | Quais projetos estão saudáveis e qual está travado? | WIP, fila, última atividade, branch e estado do merge |
| Fila | O que começa a seguir e o que espera o quê? | Trabalhos ordenados, dependências e agente sugerido |
| Upstream | O merge está sob controle? | Último relatório do agente, conflitos, portões e próxima execução |

## Merge por agente

O merge com o upstream deixa de ser tarefa do Bruno. Ele vira uma rotina semanal executada por um agente, com relatório e classes de risco.

| Classe | Critério | O que o agente faz |
|---|---|---|
| A | Conflito mecânico, sem schema, contrato, terminal ou persistência | Resolve, roda os portões e faz o merge do próprio PR |
| B | Toca schema, contrato, terminal ou persistência | Prepara a branch e o relatório, e aguarda aprovação |
| C | Conflito que não entende, ou portão falhou duas vezes | Para, não faz merge e entrega o diagnóstico |

Regras duras:

- Roda em branch nova, nunca direto no main.
- Não apaga, desliga ou pula teste para passar no portão.
- A classificação é por caminho de arquivo e falha fechada. Qualquer dúvida vira classe B.
- Não faz force push e não envia nada ao upstream.
- O relatório traz commits, conflitos, arquivos, portões, classe e tempo de agente.
- O merge do próprio PR só é permitido na classe A, com proteção de branch e caminho de reversão.

Métrica do merge deixa de ser hora do Bruno. Passa a ser número de conflitos, arquivos tocados, tempo de portão, tempo de agente e correções duplicadas encontradas.

## MVP

Dentro do escopo:

- Leitura agregada de execuções, fila e atenção por projeto.
- Aprovar, reexecutar e pausar uma execução.
- Relatório do merge por agente na visão Upstream.
- Atalho global e indicação de quantos itens precisam de decisão.

Fora do escopo:

- Arrastar cartões, editar o grafo ou desenhar no espaço.
- Agendamento automático e dependências editáveis.
- Chat com agente dentro da Mesa.
- Substituir o canvas como lugar de trabalho.

## Integração

A ordem é protótipo, spike externo e decisão.

1. **Protótipo navegável.** Valida a leitura, a hierarquia e as ações. Usa dados de exemplo. Serve para discordar barato.
2. **Spike externo.** Uma página local consumindo a interface de controle por HTTP e WS, como a CLI já faz. Ela prova duas coisas: que os dados de orquestração existem entre projetos e que a Mesa cabe fora do núcleo. O `statusView` já monta o status por vínculo com filtro de principal. Falta a agregação por projeto e a derivação da atenção.
3. **Fallback.** Se a interface pública não expuser o necessário, uma view no renderer atrás de flag. A lacuna vira exceção documentada no `FORK.md`, não refatoração do núcleo.
4. **Decisão de produto.** Se o spike provar valor em duas semanas, a Mesa vira plugin ou app local. Se não, volta para o canvas.

O spike de 2026-11-20 confirmou o caminho externo com lacunas. Projetos, links e status funcionam. Atenção só tem contagens, sem `requestId` ou `hookKey`; aprovar e liberar hooks exigem bearer admin; fila, custo e eventos de orquestração não existem. O relatório está em `spike-controle/relatorio.md`. Se a ideia voltar, o primeiro passo é expor duas leituras novas, `orch.attention.list` e `orch.run.get`, e um grant de orquestração com escopo mínimo. A fila de trabalho é decisão separada.

O risco maior não é a interface. É o read model e a autorização entre projetos. A orquestração já tem dispatch, executores, avisos, aprovações, recuperação e uma visão de status. O que não está provado é a agregação entre projetos com respeito a grant.

## Critérios de aceite

- As quatro perguntas são respondidas em menos de dez segundos, em teste com o Bruno e três cenários reais.
- Nenhum estado exibido existe sem evento que o sustente.
- A caixa de atenção fica uma semana sem falso positivo, ou com exceção documentada.
- Nenhum dado de projeto aparece sem grant.
- Aprovar duas vezes não duplica efeito. As ações são idempotentes.

## Métricas

| Métrica | Como medir | Meta inicial |
|---|---|---|
| Tempo para responder o que precisa de mim | Teste cronometrado, três cenários | Menos de 10 segundos |
| Aprovações humanas por dia | Contador de eventos | Só as irreversíveis |
| Tempo de fila por projeto | Evento de entrada e de despacho | Sem dado |
| Violações de WIP | Contador por projeto | Zero |
| Conflitos por merge | Relatório do agente | Sem dado |
| Correções duplicadas | Busca no upstream antes de corrigir | Zero por semana |

## Riscos

- **Virar mais um painel que ninguém abre.** Mitigação: atalho global, contador na barra e a Mesa como tela inicial.
- **Duplicar o canvas.** Mitigação: ler e decidir, sem edição espacial.
- **Vazar dado entre projetos.** Mitigação: filtro no servidor, teste de contrato por grant.
- **Mostrar estado velho.** Mitigação: evento confirmado e horário do último evento visível.
- **Auto-merge esconder risco.** Mitigação: classe B por caminho, falha fechada, proteção de branch e reversão.
- **Escopo explodir.** Mitigação: MVP só de leitura e três ações.

## Críticas ao plano

**Pontos fracos**

- O protótipo bonito pode criar consenso falso. Ele prova a leitura, não prova que a orquestração expõe os estados entre projetos. A prova de dados é o que decide.
- A caixa de atenção pode virar uma segunda pilha de notificações. Se entrar tudo, o Bruno ignora. A admissão precisa ser dura: irreversível, sensível, cruzado ou indefinido.
- Auto-merge de classe A depende de classificação correta. Um arquivo de schema fora do caminho previsto pode passar. A regra tem que falhar fechada e ter reversão.

**Trade-offs**

- O spike externo é mais limpo e testa a hipótese do fork fino, mas pode esbarrar em limite da interface pública. A view no renderer é mais rápida, mas adiciona divergência. O spike vem primeiro para não pagar a divergência antes da prova.
- A Mesa pode virar a tela principal e tirar protagonismo do canvas. Isso é uma aposta de produto: de workspace espacial para controle de portfólio. Precisa de validação explícita.
- Merge semanal por agente reduz duplicação, mas aumenta o churn do upstream. A classe B e os portões são o freio.

**Alternativa com mais tempo ou dados**

Instrumentar o app por duas semanas antes de desenhar: contar trocas de projeto, tempo até encontrar um estado, aprovações por dia e uso real de cada visão. Sai mais caro em tempo e mais barato em retrabalho. O caminho escolhido é protótipo agora, instrumentação durante a prova de dados.

## Nível de confiança

Alto no transporte e no catálogo. O spike provou conexão, autenticação, 159 operações, 2 projetos, 6 links e SSE. Médio no comportamento ao vivo: o banco de teste não tinha link ativo, agente ou aprovação pendente. A lacuna de atenção e o auth admin estão provados por contrato e por teste negativo. Repetir o probe com um link ativo e uma aprovação pendente é o que falta.
