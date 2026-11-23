# Fork e upstream

## Objetivo

O Glimpse é um fork do OpenCove e quer continuar recebendo updates do upstream. Isso não é conveniência. É requisito de arquitetura. Toda mudança precisa ser pensada também pelo custo de merge.

## Modelo de branches

| Branch | Papel | Regra |
|---|---|---|
| `upstream/main` | Espelho do OpenCove | Nunca commitar. Só atualizar por fetch |
| `main` | Produto do fork | Recebe merges do upstream e PRs do fork |
| `feat/*` | Features | Curtas, com escopo fechado |
| `fix/*` | Correções | Curtas, com teste de regressão |
| `refactor/*` | Refatorações | Só com mapa de divergência e PR pequeno |
| `spike/*` | Experimentos | Não entra em `main` sem decisão |

O fluxo:

```sh
git remote add upstream https://github.com/DeadWaveWave/opencove.git
git fetch upstream
git checkout main
git merge upstream/main
```

O `origin` continua sendo o fork do Bruno. O `upstream` é somente leitura.

## Semana 0: reconciliação

Antes de qualquer fase, fazer um merge de reconciliação com o upstream em branch descartável, executado pelo agente `merge-upstream`. Medir conflitos, arquivos, portões e tempo de agente. O tempo do Bruno não entra na conta.

A ordem:

1. Congelar mudanças de schema no fork.
2. Resolver a colisão de versão do banco. O fork está na 14; o upstream está na 15. A preferência é separar o banco da orquestração.
3. Rodar o merge de teste e registrar o relatório de conflitos e classes.
4. Gerar o `FORK.md` a partir do diff real.
5. Decidir pasta de dados e marca apenas se o Glimpse for distribuído.

Sem esse passo, qualquer planejamento de fases é especulação.

## Regras de mudança

1. **Aditivo antes de subtrativo.** Preferir wrapper, token e feature flag a reescrever o arquivo original.
2. **PR pequeno.** Uma mudança, um motivo. Sem renomeação em massa, sem formatação global.
3. **Sem tocar no CSS global sem necessidade.** Tokens e classes novas entram como camada aditiva.
4. **Sem podar dependência sem verificação.** Procurar uso indireto, dynamic import e referência em docs.
5. **Teste de contrato para o que cruza fronteira.** IPC, PTY, persistência e plugin.
6. **Feature flag para o que muda comportamento visível.** Permite desligar sem reverter merge.
7. **Buscar no upstream antes de corrigir.** Um sintoma pode já ter correção em outro commit, com outra mensagem e outro SHA. O caso `c05a3964` contra `b0c14242` mostra a duplicação.
8. **Documentar divergência no `FORK.md`.** O que mudou, por quê e como reverter.

## Mapa de divergências

O `FORK.md` na raiz do fork deve ter uma tabela:

| Área | Arquivos | Motivo | Risco de conflito | Como reverter |
|---|---|---|---|---|
| Agent MCP | `contexts/agent`, `main/controlSurface` | Aprovações de MCP | Médio | Reverter commits |
| Orquestração | `contexts/orchestration`, `docs/architecture` | Fluxo próprio | Alto | Feature flag |
| Motion | `app/renderer`, CSS | Tokens e wrapper | Médio | Camada aditiva |

O mapa não é documentação morta. Ele é o que permite decidir se um merge vale a pena.

## Estratégia de merge

1. **Atualizar `upstream/main` com frequência.** Quanto maior o intervalo, maior o conflito.
2. **Merge pequeno e frequente.** Não acumular seis meses de upstream.
3. **Merge commit, não rebase.** Preserva histórico e facilita auditoria.
4. **Rodar testes de contrato antes e depois.** O merge não é concluído só porque compila.
5. **Registrar conflitos resolvidos.** O próximo merge vai passar pelo mesmo lugar.

## Merge por agente

Decisão D011: o merge semanal é executado por um agente. Ele roda em branch nova e entrega um relatório. O Bruno lê o relatório e decide só a classe B.

| Classe | Critério | Ação do agente |
|---|---|---|
| A | Conflito mecânico, sem schema, contrato, terminal ou persistência | Resolve, roda os portões e faz o merge do próprio PR |
| B | Toca schema, contrato, terminal ou persistência | Prepara a branch e o relatório, e aguarda aprovação |
| C | Conflito que não entende, ou portão falhou duas vezes | Para, não faz merge e entrega o diagnóstico |

Regras duras:

- A classificação é por caminho de arquivo e falha fechada. Qualquer dúvida vira classe B.
- Não apaga, desliga ou pula teste para passar no portão.
- Não faz force push e não envia nada ao upstream.
- O auto-merge da classe A exige proteção de branch e caminho de reversão.
- O relatório traz commits, conflitos, arquivos, portões, classe e tempo de agente.

O merge por agente não substitui a estratégia de fork. Ele só funciona com mudanças pequenas, testes confiáveis e classificação conservadora.

## Poda sem conflito

A poda de dependências e código morto deve ser:

- Em PRs separados por item.
- Com busca de uso indireto.
- Com build e testes verdes.
- Com possibilidade de reverter em um comando.
- Sem tocar em arquivos que o upstream mudou recentemente.

Itens candidatos do levantamento:

- `react-router-dom`, sem imports.
- `tailwindcss`, sem classes utilitárias.
- `class-variance-authority` e `tailwind-merge`, sem uso.
- Parser de diff não usado.

Antes de remover, verificar: imports dinâmicos, referências em scripts, docs, testes, plugins e builds.

## Checklist de PR do fork

- [ ] O PR tem um motivo só.
- [ ] O diff é pequeno e revisável.
- [ ] Não renomeia arquivos sem necessidade.
- [ ] Não muda CSS global sem camada aditiva.
- [ ] Tem teste de contrato ou regressão.
- [ ] Tem impacto de performance declarado, se aplicável.
- [ ] Tem custo de divergência declarado.
- [ ] Pode ser revertido sem quebrar o produto.
- [ ] `FORK.md` foi atualizado, se a divergência é nova.
- [ ] `pnpm verify:quick` passou.

## Riscos

- **Fork divergente demais.** O upstream vira irrelevante e o custo de merge explode.
- **Fork raso demais.** O produto não evolui porque tudo é espera pelo upstream.
- **Refatoração estética.** Muda arquivos sem ganho funcional e cria conflito eterno.
- **Poda prematura.** Remove algo que o upstream passaria a usar.
- **Merge agêntico sem teste.** Resolve conflito sintaticamente e quebra semântica.

## Decisão

- **Data**: 2026-11-13.
- **Decisão**: manter o upstream como fonte de updates, com mudanças aditivas e PRs curtos.
- **Consequência**: a Fase 4 de poda é incremental e reversível. O motion system entra como camada, não como reescrita.
