# Organograma do Glimpse

Mapa navegável do estado atual do fork, com o que veio da estrutura base do OpenCove e o que é trabalho do Glimpse. Levantamento de 2026-11-14, HEAD `9e1fe4c7`, branch `docs/orchestration-adr`.

## Como abrir

Abra `index.html` direto no navegador (`file://`). Não há servidor, build, CDN, fonte externa, rede nem analytics. As visões usam o hash da URL, então o botão voltar funciona e cada item tem link direto, por exemplo `#/propriedade?sel=p-orch`.

Atalhos: `/` ou `Ctrl+K` abre a busca, setas movem entre cartões, `Enter` abre, `Esc` fecha.

## O que está no mapa

| Visão | Pergunta que responde |
|---|---|
| Visão geral | Quais são os seis sistemas e qual é a proporção entre base e Glimpse? |
| Camadas | Onde cada processo e camada vive, do renderer ao banco? |
| Propriedade | Quanto cada área tem de código, quanto o fork alterou e qual é a decisão? |
| Riscos | O que pode quebrar o plano, com probabilidade, impacto e mitigação? |

## A leitura central

O `main` do fork está no mesmo commit do merge-base com o upstream: não tem commit próprio e está 99 commits atrás. O trabalho do Glimpse está na branch `docs/orchestration-adr`: 47 commits, 373 arquivos, 40.129 linhas adicionadas e 992 removidas.

A divergência é concentrada:

| Área | Arquivos no diff | Linhas adicionadas |
|---|---:|---:|
| Orquestração | 54 | 7.311 |
| Main e control surface | 50 | 2.896 |
| Testes | 165 | 23.588 |
| Documentação | 21 | 3.160 |
| Agentes | 15 | 601 |
| Workspace | 17 | 174 |
| Contratos compartilhados | 12 | 470 |
| Persistência | 7 | 312 |
| Renderer | 14 | 306 |
| CLI | 3 | 624 |
| Settings | 5 | 70 |
| Worker | 1 | 7 |

O restante, incluindo canvas, terminal, plugins, website nodes, shell e i18n, segue base intocada.

## Como atualizar os dados

Tudo o que se lê na tela vem de `data/dados.js`. O código em `js/` e `css/` não guarda fato.

| Campo | Conteúdo |
|---|---|
| `meta` | Produto, base, SHA, branch e resumo |
| `views` | As quatro visões, com kicker, título e descrição |
| `nodes` | Itens visíveis, com id, visão, grupo, status, linhas, arquivos, diff, resumo, detalhe, fonte e decisão |
| `relations` | Ligações entre itens, com rótulo |

Status possíveis:

- `base`: estrutura do OpenCove sem alteração do fork.
- `fork`: criado ou majoritariamente alterado pelo Glimpse.
- `misto`: base com alterações do Glimpse.
- `morto`: candidato a poda.
- `risco`: risco ou lacuna.

Depois de editar, rode:

```sh
node validar.mjs
```

O validador confere IDs duplicados, visões vazias, relações quebradas, fonte e status em todo nó, e a higiene de texto (sem em dash).

## Fontes

- `git merge-base`, `git rev-list` e `git diff` entre `2cf2710b` e `9e1fe4c7`.
- Contagem de linhas e arquivos do checkout local.
- `package.json`, `electron.vite.config.ts` e `src/app/main/appRuntimeConfig.ts`.
- `docs/knowledge/` para as decisões, riscos e o plano.
- `tests/perf` para a suíte de performance existente.
- `src/platform/persistence/sqlite/constants.ts` para a versão do banco.

Nenhum dado é lido em tempo real. O organograma é uma fotografia.

## Limites conhecidos

- O diff da branch inclui testes e documentação, o que infla a contagem de linhas em relação ao código de produto.
- O número de arquivos alterados por área é uma agregação por prefixo de caminho, não uma classificação manual arquivo a arquivo.
- O status `misto` indica alteração do fork, não grau de conflito com o upstream.
- O mapa não mede uso real. A visão de propriedade mostra o que existe no código, não o que o Bruno usa todos os dias.
- A colisão de schema é inferida da comparação entre a versão 14 do fork e a 15 do upstream. O teste de migração ainda não foi rodado. Os dados locais são de teste e podem ser recriados, então o risco é a numeração da migração, não o histórico.

## Decisões de design

1. Direção editorial técnica, papel azulado, linhas finas e uma cor de destaque por status.
2. Status nunca depende só de cor: cada cartão tem etiqueta escrita, borda colorida e posição no grupo.
3. O mapa prioriza leitura em três tempos: visão geral, cartões por grupo e painel de detalhe.
4. A busca cobre nome, resumo, detalhe, fonte, grupo e status.
5. O painel mostra números, fonte, decisão e relações, sem esconder conteúdo em dica de mouse.
6. Claro e escuro com `prefers-color-scheme` e alternância manual; movimento reduzido zera transições.
7. Impressão em A4 paisagem, com cartões em duas colunas e sem o painel.
8. O código não guarda fato. Tudo vem de `data/dados.js`.
