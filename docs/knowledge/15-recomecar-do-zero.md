# Recomeçar do zero

## A pergunta

Vale abandonar o fork e começar um projeto novo, em vez de adaptar e limpar o Glimpse atual?

## Veredito

Não. O "lixo" que incomoda é uma parte pequena do sistema. A parte cara, que é terminal que sobrevive a reinícios, canvas, retomada de sessão e recuperação, é justamente a que o upstream conserta todos os dias. Recomeçar troca uma dor de organização por uma perda de confiabilidade.

O problema real não é a base. É o jeito como o fork diverge. A orquestração e o MCP foram costurados dentro do núcleo, quando poderiam ter sido construídos ao lado dele.

## O que "recomeçar do zero" pode significar

| Cenário | O que é na prática | O que se reaproveita |
|---|---|---|
| **A. App novo só com o núcleo** | Projeto novo, com canvas, terminal, agentes e orquestração escritos de novo | Ideias e talvez bibliotecas. Nenhum código |
| **B. Fork limpo com partes portadas** | Partir do OpenCove atual ou de um repositório vazio, trazendo módulo por módulo | Código selecionado. O vínculo com o upstream se perde na primeira grande poda |
| **C. Reescrita total** | Tudo de novo: interface, backend, persistência, plugins, updater e testes | Nada além de aprendizado |

O ponto que quase ninguém percebe: B e C acabam virando A em poucos meses. Quem poda pesado e reorganiza perde a capacidade de receber updates do upstream. A partir daí, todo conserto passa a ser trabalho próprio.

## Custos e prazos

Não existe estimativa medida para uma reescrita na mesma stack. O único número do repositório é o do Rune: 52 a 76 pessoa-mês só para a camada visual. Ele não se aplica diretamente, porque reescrever em React é mais barato. A tabela abaixo dá ordem de grandeza e o que teria de ser refeito.

| Cenário | O que precisaria ser refeito | Ordem de grandeza | Risco dominante |
|---|---|---|---|
| A | Restauração de terminal, tela alternativa, retomada de sessão, autoridade de conexão, geometria e persistência com migração | Meses a mais de um ano para uma pessoa com agentes | Repetir os bugs que o estudo de caso documentou: vários processos escrevendo o mesmo estado e perda de histórico |
| B | Separar o que se usa do que não se usa num sistema com 151 operações de controle e 5.961 testes acoplados | Semanas para a primeira versão, custo contínuo depois | Remover algo usado de forma indireta e perder o upstream sem perceber |
| C | Tudo de A, mais plugins, versão web, updater e 285 mil linhas de teste | Mais caro que A | O produto diário para de evoluir durante a reescrita |

Dois custos ficam fora de qualquer tabela:

- **Dados.** O banco do Bruno está na versão 14 do fork. Qualquer cenário novo precisa migrar esse banco ou começar sem histórico.
- **Uso diário.** Enquanto a versão nova não alcança a atual, o Bruno usa duas ferramentas ou fica com a velha congelada.

## O que se ganha

- Arquitetura do jeito do Bruno, sem herdar decisões nem idioma de documentação de outra pessoa.
- Fim do custo de merge. O upstream avança cerca de 16 commits por dia e isso deixa de pesar.
- Escopo mínimo, sem versão web, sem configurações que ninguém usa e com só o idioma que importa.
- Liberdade de marca e de distribuição.
- Independência de um mantenedor praticamente único. Cerca de 673 dos 767 commits vêm de dois apelidos do mesmo dono. É um risco estrutural que a análise anterior não destacou.

## O que se perde

- O conserto gratuito da parte mais difícil. Em seis dias, o upstream corrigiu restauração da tela alternativa do terminal, revelação de janela do Claude, encerramento de processos ao fechar janela e geração de credenciais seguras.

  Verificação de 2026-11-17:

  | Commit | Autor | Data | Correção |
  |---|---|---|---|
  | `b945a20c` | DeadWave | 2026-11-09 | Mantém a tela alternativa e os modos de input quando a janela do agente remonta. Afetava 6 de 9 caminhos de remontagem |
  | `b0c14242` | DeadWave | 2026-11-08 | Revela a janela nova do Claude Code quando a primeira saída chega tarde |
  | `6ed41b9d` | DeadWave | 2026-11-09 | Encerra os processos que o agente iniciou quando a janela fecha |
  | `c3dd433c` | DeadWave | 2026-11-08 | Gera tokens de controle seguros para a CLI |

  Nenhum desses commits está no `main` do fork. O fork está 99 commits atrás e não recebeu as correções. O commit `c05a3964` do Bruno, de 2026-11-13, trata do mesmo sintoma do `b0c14242`: um agente novo com sessão verificada foi tratado como restaurado e o terminal esperou saída que não vinha. É duplicação provável de uma correção que já existia no upstream.
- A rede de testes: 5.961 casos, suíte de performance e testes de contrato.
- A interface de controle versionada, com protocolo, registro de operações, HTTP, eventos e WebSocket para terminal.
- O trabalho recente do Bruno: cerca de 7,3 mil linhas de orquestração, com recuperação e testes reais com o Codex.
- Ritmo de produto. Por meses, a energia vai para alcançar o que já existe.

## Meio-termo viável

**Opção 1: novo app que consome o processo de fundo existente.** É tecnicamente possível. O processo de fundo roda sem o Electron, e a interface de controle é pública e versionada. O problema é o tamanho do cliente: canvas e terminal teriam de refazer a hidratação do terminal no navegador, que é onde o upstream mais corrige. Só vale se o cliente for diferente de propósito, como um painel de fila de agentes, não um segundo canvas.

**Opção 2: fork enxuto com poda agressiva.** Descartada. Poda agressiva é o caminho mais rápido para perder o upstream e ficar com o pior dos dois mundos: custo de manutenção próprio sem liberdade de arquitetura.

**Opção 3, a recomendada: upstream quase intocado e o Glimpse ao lado dele.**

- O OpenCove roda praticamente sem alterações.
- A orquestração sai do núcleo e vira um serviço vizinho, que conversa com o processo de fundo pela interface de controle, como o terminal de linha de comando já faz.
- A interface própria entra como plugin, que já suporta view em iframe e processo em Node.
- O que for melhoria genérica, como desempenho, poda, tokens de animação e correções de agente, vai como contribuição ao upstream.
- Resultado esperado: o fork encolhe para uma lista curta e documentada de alterações. O conflito de schema some, porque o banco da orquestração passa a ser próprio.

Ainda falta provar se a interface de controle e os plugins expõem o suficiente. A orquestração registra operações próprias dentro do núcleo e usa eventos internos. Esse é o ponto que o teste de duas semanas precisa responder.

## Critérios de decisão

| Critério | Como medir | Aponta para |
|---|---|---|
| Custo semanal de merge | Tempo real de um merge de teste agora e por três semanas | Mais de meio dia por semana de forma recorrente: rever a estratégia. Menos: manter o vínculo |
| Fração da divergência no núcleo | Arquivos do fork em persistência, agentes e controle, comparados ao total | Se a maior parte for orquestração movível: Opção 3 |
| A orquestração cabe na interface pública? | Teste de duas semanas rodando fora do núcleo | Sim: Opção 3. Não: fork fino com lista de exceções |
| A experiência desejada ainda é um canvas? | Pergunta direta e as cinco funções mais usadas | Se não for: cliente novo sobre o processo de fundo |
| Saúde do upstream | Commits por semana e mantenedores ativos nos próximos três meses | Upstream parado: o fork vira produto e recomeçar ganha força |
| Dor real | Lista datada de problemas do uso diário | Se for confiabilidade, recomeçar piora. Se for direção de produto, abre espaço para a Opção 1 |

## Críticas ao plano

**Pontos fracos da recomendação**

- A Opção 3 aposta que a interface de controle e os plugins bastam, mas isso não foi testado. Se a orquestração precisar de ganchos internos, o ganho cai.
- Depender de um mantenedor praticamente único é risco estrutural. Se ele mudar de direção, de licença ou parar, ficar colado ao upstream terá sido custo sem retorno.
- Contribuições genéricas passam a depender de aprovação de outra pessoa e do padrão dela.

**Trade-offs**

- A Opção 3 troca liberdade de arquitetura por consertos gratuitos. O Bruno aceita que canvas, terminal e persistência não sejam "dele".
- Recomeçar troca meses de ritmo de produto por uma base sob controle total. Só compensa se a direção do produto for de fato diferente da do OpenCove.
- O plugin isola, mas limita a interface ao que o iframe permite. Animação de nó no canvas continua exigindo mexer no núcleo.

**Alternativa com mais tempo ou dados**

Rodar três testes em paralelo, com prazo fechado:

1. Um merge de teste para medir o conflito real.
2. A orquestração fora do núcleo, consumindo a interface de controle.
3. Um protótipo mínimo de cliente diferente, como um painel de fila de agentes, sobre o processo de fundo.

Decidir com os três números. Se o upstream mostrar sinais de abandono nesse período, recomeçar o cliente sobre o processo de fundo ganha força.

## Recomendação

No lugar do Bruno, nesta ordem:

1. **Agora:** congelar mudanças de schema e resolver a colisão da versão 14. É pré-requisito em qualquer cenário, inclusive recomeçar.
2. **Semana 1:** merge de reconciliação com o upstream, medindo o tempo. Descartar correções do fork que o upstream já cobre.
3. **Semanas 2 e 3:** testar a orquestração como serviço vizinho e a interface como plugin.
4. **Decisão depois disso:**
   - Se o teste passar, o fork fica fino, com lista curta e documentada de alterações, e o resto vai para o upstream.
   - Se falhar, o fork continua com a orquestração dentro, mas sem poda e sem alterações estéticas no núcleo.
   - Se o Bruno quiser outra experiência, cliente novo sobre o processo de fundo, nunca uma reescrita do processo de fundo.

**Por quê:** recomeçar resolve uma dor de organização com um custo de confiabilidade. Confiabilidade é o que o produto não pode perder, e os consertos dos últimos seis dias mostram onde ela se ganha. O caminho que mantém o upstream e tira a divergência do núcleo entrega quase toda a base limpa desejada, pelo menor custo.

## Nível de confiança

**Médio.**

- **Verificado:** o processo de fundo roda sem o Electron, a interface de controle tem versão, registro de operações, HTTP e WebSocket, a divergência e a colisão de schema existem, e o upstream entregou correções de terminal e agente nos últimos dias.
- **Não verificado:** se os plugins e a interface pública expõem o suficiente para a orquestração. O custo de merge não foi medido. O que o Bruno quer como experiência ainda não foi respondido.
- **O que aumentaria a confiança:** o merge de teste com tempo registrado, o teste de duas semanas da orquestração fora do núcleo e as respostas sobre a dor diária e a direção do produto.
