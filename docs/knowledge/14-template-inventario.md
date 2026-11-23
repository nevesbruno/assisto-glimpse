# Template de inventário funcional

Este é o roteiro do inventário. O objetivo é transformar o mapa de código num mapa de uso e decisão. Uma página por área, curta e acionável.

## Formato de uma página

```md
# Área: <nome>

## O que faz
<duas a quatro frases, em linguagem de produto>

## Quem usa
<o dono usa? com que frequência? é core, suporte ou experimental?>

## Onde vive
<contextos, componentes, main, worker>

## Tamanho
<linhas, arquivos, testes>

## Dependências críticas
<libs, APIs, serviços>

## Fluxo principal
<passo a passo do uso real>

## Estados e invariantes
<o que não pode quebrar>

## Riscos
<o que dói hoje: bug, lentidão, confusão, código morto>

## Custo de divergir do upstream
<baixo, médio, alto, com motivo>

## Decisão
<manter, podar, otimizar, adiar, remover>

## Próximo passo
<ação concreta, com dono e critério>
```

## Ordem das áreas

1. Canvas
2. Terminal
3. Agent
4. Plugins
5. Shell
6. Settings
7. Website nodes
8. Documento e imagem
9. Tasks e notas
10. Orchestration
11. Worktree e git
12. i18n
13. Performance monitor
14. Update e release

## Perguntas por área

### Canvas

- O dono usa pan, zoom, trackpad, snapping, colagem e minimapa todos os dias?
- Quantos nós costuma ter num workspace real?
- Quais efeitos visuais são úteis e quais são decoração?
- O colapso de nós é usado?
- Quais invariantes de geometria precisam de teste?
- Quanto do React Flow é essencial e quanto é conveniência?

### Terminal

- Quantos terminais ficam abertos ao mesmo tempo?
- WebGL é necessário em todos ou só nos visíveis?
- O scrollback é perdido em algum cenário?
- A restauração funciona com TUI pesada?
- Quais addons são realmente usados?
- O multi-client é usado ou é hipótese?

### Agent

- Quais providers o dono usa?
- Quantas sessões simultâneas?
- O transcript é lido no app ou só no terminal?
- Permissões e MCP são usados todos os dias?
- O que quebra quando uma CLI externa atualiza?
- A retomada de sessão é confiável?

### Plugins

- Quantos plugins instalados?
- Quais contribuições são usadas: view, comando, skill, tema, sidebar, backend?
- O iframe é essencial?
- O backend Node é usado?
- Qual é o risco de segurança aceito?
- Quanto custa manter a compatibilidade?

### Shell

- Quais entradas o dono usa: Command Center, Control Center, Agent Island, busca?
- Qual informação precisa estar visível de longe?
- Quais atalhos são usados?
- O que é ruído visual?
- Quais animações informam estado e quais enfeitam?

### Settings

- Quais páginas o dono abriu no último mês?
- Quais opções nunca foram mudadas?
- Quais opções existem só para diagnóstico?
- Quais podem ser agrupadas ou removidas?
- Quais defaults poderiam substituir opções?

### Website nodes

- O dono usa sites embutidos?
- Com que frequência?
- O zoom quebra o mapeamento?
- O custo de manutenção se justifica?
- Se sair, qual é o fallback?

### Documento e imagem

- O Monaco é usado para código ou para texto?
- Quantos documentos abertos ao mesmo tempo?
- O bundle de 32 MB se justifica?
- Um editor mais simples resolveria?
- Imagem e pasta são usadas?

### Tasks e notas

- As tarefas são usadas ou o dono planeja em outro lugar?
- A ligação com sessão de agente é usada?
- As notas são usadas?
- O textarea puro basta?

### Orchestration

- O dono usa papéis e filas?
- Quantas execuções paralelas?
- O fluxo é confiável?
- Se não usa, é código morto caro?

### Worktree e git

- Worktrees são usados todos os dias?
- PRs aparecem no canvas?
- O diff viewer faz falta?
- O fluxo de git é completo ou parcial?

### i18n

- O dono usa inglês ou português?
- O zh-CN é usado?
- Quanto custa manter duas línguas?
- Vale manter ou reduzir?

### Performance monitor

- O monitor é usado?
- Quais métricas importam?
- Falta atribuição por causa?
- Vale investir em tracing integrado?

### Update e release

- O auto-update funciona?
- Qual é o custo de assinatura e notarização?
- O canal nightly é usado?
- Qual é a cadência de release?

## Como coletar evidência

- **Código**: grep, contagem de linhas, imports, testes.
- **Uso**: revisão honesta do dono, histórico de git, logs locais, telemetria opcional.
- **Performance**: monitor embutido, Chrome tracing, React Profiler, xterm stats.
- **Confiabilidade**: casos em `docs/cases`, issues, testes que falham.
- **Upstream**: diff entre `upstream/main` e `main`, arquivos mais alterados.

## Critérios de decisão

| Decisão | Quando |
|---|---|
| Manter | É core, é usado, tem teste e custo de divergência aceitável |
| Otimizar | É usado, mas custa frame, memória ou tempo |
| Podar | Não é usado, é duplicado, é morto ou é caro sem retorno |
| Adiar | É promissor, mas não é prioridade agora |
| Remover | Não é usado, não é core e tem custo de manutenção alto |

## Regra de ouro

Inventário sem decisão é documentação morta. Cada página termina com uma ação concreta e um critério de sucesso.
