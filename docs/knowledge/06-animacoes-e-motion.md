# Animações e sistema de motion

## Por que esta é uma área prioritária

O Glimpse é um produto visual. O canvas, os estados de agente, o colapso de nós, os sinais de janela e a parede de pixels carregam informação. Animação não é enfeite: é como o produto comunica que algo está vivo, esperando ou terminou.

O levantamento encontrou 40 animações definidas em 23 arquivos, com 75 usos, 83 transições, 46 `backdrop-filter`, 184 sombras e 62 filtros espalhados por 22.712 linhas de CSS. Não há um sistema. Há um conjunto de decisões locais que funcionou até agora.

Isso preocupa por três motivos:

1. **Custo imprevisível.** Animação de layout, blur e sombra custa caro. Sem classificação, não dá para saber o que drena o frame.
2. **Inconsistência de feel.** Durações e curvas diferentes fazem o app parecer montado por pessoas diferentes.
3. **Manutenção.** Cada nova feature inventa sua própria animação. O custo cresce com o produto.

A boa notícia: o app já respeita `prefers-reduced-motion` em vários pontos e já tem efeitos WebGL no lugar certo. A base não é ruim. Falta sistema.

## Inventário de motion

O primeiro artefato é uma tabela com uma linha por animação:

| Campo | O que registrar |
|---|---|
| Nome | Identificador legível |
| Onde vive | Arquivo, componente ou CSS |
| Gatilho | Entrada, saída, hover, press, estado de agente, troca de tema |
| Propriedade animada | transform, opacity, width, height, background, filter, etc. |
| Duração | Valor atual |
| Curva | Easing ou spring atual |
| Custo | Compositor, layout, paint, JS ou WebGL |
| Reduced motion | Respeita? Como? |
| Dono | Quem mantém |
| Decisão | Manter, unificar, migrar, remover |

São 40 animações definidas, com 75 usos. O inventário deve ser por definição, com os usos como atributo de cada uma. Dá para fazer em duas ou três ondas, priorizando as que rodam em áreas grandes e as que animam propriedades caras.

## Classificação por custo

| Categoria | Exemplos | Custo | Regra |
|---|---|---|---|
| Compositor | transform, opacity | Baixo | Padrão para tudo que se move |
| Layout | width, height, top, left, margin, padding | Alto | Migrar para transform ou FLIP |
| Paint | background, box-shadow, filter, backdrop-filter | Alto | Evitar animar. Blur é estático |
| JS por frame | requestAnimationFrame, canvas 2D | Variável | Só onde o compositor não alcança |
| WebGL | parede de pixels, partículas | Baixo no GPU, alto no CPU | Já está no lugar certo, mas precisa de budget |

Regras práticas:

- Movimento de posição e tamanho deve usar transform.
- Mudança de layout que precisa animar deve usar FLIP: medir antes, aplicar, medir depois, animar a diferença com transform.
- Blur, sombra e filtro não devem animar. Se precisar de transição, anime a opacidade de uma camada pré-renderizada.
- Partículas e efeitos de canvas precisam de orçamento, pausa em background e corte em reduced motion.

## Tokens de motion

O sistema deve ter poucos tokens, não uma coleção.

Proposta inicial:

| Token | Valor | Uso |
|---|---|---|
| `motion.instant` | 0 ms | Mudanças sem animação, drag |
| `motion.fast` | 120 ms | Hover, press, foco |
| `motion.base` | 200 ms | Entrada e saída de painéis pequenos |
| `motion.calm` | 320 ms | Colapso, reorganização, transição de tema |
| `ease.out` | cubic-bezier(0.2, 0, 0, 1) | Padrão de entrada |
| `ease.inOut` | cubic-bezier(0.4, 0, 0.2, 1) | Movimento com ida e volta |
| `spring.snappy` | duração 0.25 s, bounce 0 | Resposta imediata |
| `spring.default` | duração 0.3 s, bounce 0 | Padrão |
| `spring.calm` | duração 0.4 s, bounce 0 | Mudanças grandes |

Os valores são ponto de partida. O importante é que nenhuma animação nova invente duração ou curva fora da tabela sem justificativa escrita.

## Lib ou motor próprio

A recomendação é usar tokens CSS para hover, press, foco e transições declarativas. Uma lib entra só para presença e springs com retomada de velocidade, em poucos componentes. Motion (antigo Framer Motion) cobre isso, mas cria uma segunda stack. A regra é: CSS para o declarativo, lib para o que o CSS não faz bem.

Construir um motor próprio é permitido apenas se um caso concreto falhar na lib. Os motivos para não construir:

- Você vira mantenedor de física, interpolação, cancelamento, fila e acessibilidade.
- O ganho sobre uma lib madura é marginal para UI.
- O custo de manutenção cresce junto com o produto.
- O tempo gasto é tempo que não vai para o canvas e para os agentes.

O que vale copiar do Rune é o modelo, não o código: springs analíticos, retarget preservando posição e velocidade, presença com saída animada, animação fora do ciclo de render do React, reduced motion como cidadão de primeira classe.

## Estratégia de migração

Não migrar as 40 animações de uma vez. Três ondas:

**Onda 1: tokens e casos visíveis.**
- Criar os tokens.
- Migrar hover, press, foco e o colapso de nó.
- Entregar uma animação emblemática que o dono perceba no uso diário.
- Medir frame p95 antes e depois.

**Onda 2: propriedades caras.**
- Migrar animações de layout para transform ou FLIP.
- Remover animação de blur, sombra e filtro.
- Substituir por opacidade de camada pré-renderizada quando necessário.
- Medir long tasks e memória.

**Onda 3: efeitos de canvas.**
- Orçamento de partículas.
- Pausa em background.
- Corte em reduced motion.
- Medição de CPU e GPU.

Cada onda tem uma meta e um critério de parada. Se a onda não mover a métrica, não continuar.

## Metas

| Métrica | Meta |
|---|---|
| Frame p95 no pan com 20 nós | abaixo de 16 ms |
| Long tasks acima de 50 ms no pan | zero |
| Animações que animam layout | zero, exceto FLIP |
| Animações que animam blur ou sombra | zero |
| Animações sem reduced motion | zero |
| Animações rodando em background | zero |
| Tokens de duração | no máximo 5 |
| Tokens de curva | no máximo 4 |

## Riscos

- **Overengineering.** Criar um sistema elaborado para 40 animações e nunca migrar todas.
- **Regressão de feel.** Unificar demais e perder a personalidade do produto.
- **Custo de teste.** Animações são difíceis de testar. O app já tem traces e testes de geometria. Usar.
- **Conflito com upstream.** Migrar CSS globalmente gera conflito em quase todo merge. Preferir camada aditiva e migração por componente.
- **Falta de medição.** Sem baseline, a discussão vira gosto.

## O que não fazer

- Não adicionar uma segunda stack de animação.
- Não animar propriedades de paint em elementos grandes.
- Não usar `will-change` em tudo. Ele consome memória e pode piorar.
- Não remover o respeito a reduced motion para ganhar consistência.
- Não migrar o app inteiro antes de provar ganho em uma onda.

## Relação com o Rune

O Rune não será usado como motor. O headless dele é ferramenta de teste e gravação, não API de render embutível. O modelo de motion dele é a referência: springs analíticos, retarget com velocidade, presença, tokens e reduced motion.

Se no futuro houver interesse em validar feel, um protótipo isolado em Rune pode servir de laboratório. Ele não entra no build e não vira dependência.
