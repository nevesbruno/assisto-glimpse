/*
 * Dados do organograma do Glimpse.
 * Levantamento de 2026-11-13/14, HEAD 9e1fe4c7, branch docs/orchestration-adr.
 * Cada nó carrega fonte e status. O código em js/ não guarda fato.
 */
(function () {
  const meta = {
    produto: 'Glimpse',
    base: 'OpenCove 0.4.0',
    sha: '9e1fe4c7',
    branch: 'docs/orchestration-adr',
    data: '2026-11-14',
    resumo:
      'Fork do OpenCove em Electron + React 19 + React Flow + xterm 6 + Monaco. O main do fork está 99 commits atrás do upstream e sem divergência. O trabalho do Glimpse vive na branch docs/orchestration-adr: 47 commits, 373 arquivos, 40.129 linhas adicionadas e 992 removidas.',
  };

  const views = [
    {
      id: 'geral',
      label: 'Visão geral',
      short: 'Geral',
      kicker: 'Leitura em dez segundos',
      title: 'O que é base e o que é Glimpse',
      description:
        'Seis sistemas. A etiqueta diz se a área veio do fork, se foi modificada ou se ainda é estrutura base. Os números de linhas são do checkout atual.',
      summaryLabel: 'linhas somadas nos sistemas',
    },
    {
      id: 'camadas',
      label: 'Camadas',
      short: 'Camadas',
      kicker: 'Do pixel ao banco',
      title: 'Processos e camadas',
      description:
        'Renderer, preload, main, worker, PTY, plugins e CLI. A coluna de propriedade mostra onde o fork mexeu e onde a base segue intocada.',
      summaryLabel: 'linhas somadas nas camadas',
    },
    {
      id: 'propriedade',
      label: 'Propriedade',
      short: 'Dono',
      kicker: 'Quem escreveu o quê',
      title: 'Mapa de propriedade',
      description:
        'Cada área com linhas totais, arquivos alterados pela branch e saldo de linhas. A decisão provisória indica manter, otimizar, isolar ou podar.',
      summaryLabel: 'linhas somadas nas áreas',
    },
    {
      id: 'riscos',
      label: 'Riscos',
      short: 'Riscos',
      kicker: 'O que pode quebrar',
      title: 'Riscos e lacunas',
      description:
        'Riscos priorizados por probabilidade e impacto. O primeiro é a distância do upstream e o custo de reconciliar.',
      summaryLabel: 'linhas nas áreas afetadas',
    },
  ];

  const nodes = [
    // Visão geral
    {
      id: 'g-canvas',
      view: 'geral',
      group: 'Produto',
      name: 'Canvas e Workspace',
      status: 'misto',
      lines: 97990,
      files: 17,
      added: 174,
      removed: 26,
      summary:
        'Canvas infinito, nós, seleção, pan, zoom, spaces, colapso, explorer e sinais visuais. É o coração do produto e a maior área do código.',
      detail:
        '53.846 linhas no canvas, 362 arquivos e 168 hooks. O fork alterou 17 arquivos, principalmente links de orquestração no canvas e ajustes de workspace. A base React Flow segue dominante.',
      source: 'src/contexts/workspace, git diff 2cf2710b..9e1fe4c7',
      decision: 'Otimizar e manter',
    },
    {
      id: 'g-terminal',
      view: 'geral',
      group: 'Produto',
      name: 'Terminal e Agentes',
      status: 'misto',
      lines: 36699,
      files: 15,
      added: 601,
      removed: 130,
      summary:
        'xterm 6 com sete addons, PTY, restauração de scrollback, geometria, providers Claude Code e Codex, permissões e MCP.',
      detail:
        '17.675 linhas no componente de terminal e 19.024 no contexto de agent. O fork mexeu em 15 arquivos de agent e 3 de terminal, incluindo retomada de sessão e aprovações de MCP.',
      source: 'src/contexts/agent, src/contexts/workspace/.../terminalNode',
      decision: 'Congelar e manter',
    },
    {
      id: 'g-shell',
      view: 'geral',
      group: 'Produto',
      name: 'Shell e Settings',
      status: 'base',
      lines: 43708,
      files: 5,
      added: 70,
      removed: 0,
      summary:
        'Header, sidebar, Command Center, Control Center, Agent Island, busca global e dezoito páginas de settings.',
      detail:
        '28.107 linhas no shell e 15.601 em settings. O fork alterou cinco arquivos de settings, sem tocar no shell. É a área mais visível e a mais barata de manter.',
      source: 'src/app/renderer/shell, src/contexts/settings',
      decision: 'Manter e podar opções',
    },
    {
      id: 'g-orch',
      view: 'geral',
      group: 'Serviços',
      name: 'Orquestração',
      status: 'fork',
      lines: 6860,
      files: 54,
      added: 7311,
      removed: 0,
      summary:
        'Papéis, filas, dispatch, executores, links no canvas, notices, aprovações e recuperação. É a área mais autoral do fork.',
      detail:
        '54 arquivos alterados e 7.311 linhas adicionadas. O contexto isolado tem 6.860 linhas, mas o diff inclui testes, contratos e integração com main, CLI e workspace.',
      source: 'src/contexts/orchestration, git diff',
      decision: 'Manter, é o diferencial',
    },
    {
      id: 'g-servicos',
      view: 'geral',
      group: 'Serviços',
      name: 'Serviços e Dados',
      status: 'misto',
      lines: 44992,
      files: 58,
      added: 3215,
      removed: 183,
      summary:
        'Main process, control surface, worker, PTY host, SQLite, persistência e recuperação. O fork adicionou operações orch e tabelas próprias.',
      detail:
        '40.913 linhas no main, 31.688 delas em control surface. O fork alterou 50 arquivos do main, 7 de persistência e 1 do worker. É onde vive a colisão de schema.',
      source: 'src/app/main, src/platform/persistence, src/app/worker',
      decision: 'Isolar schema e manter',
    },
    {
      id: 'g-ext',
      view: 'geral',
      group: 'Extensões',
      name: 'Extensões',
      status: 'base',
      lines: 18746,
      files: 0,
      added: 0,
      removed: 0,
      summary:
        'Plugins em iframe HTML/CSS com backend Node, temas, website nodes com WebContentsView e i18n.',
      detail:
        '10.169 linhas de plugins, 3.228 de website nodes e 5.349 de i18n. O fork não alterou essa área. É a que mais depende do browser e a mais difícil de portar.',
      source: 'src/contexts/plugins, website nodes, i18n',
      decision: 'Isolar e medir uso',
    },

    // Camadas
    {
      id: 'c-renderer',
      view: 'camadas',
      group: 'Renderer',
      name: 'Renderer React',
      status: 'misto',
      lines: 187483,
      files: 14,
      added: 306,
      removed: 24,
      summary:
        'Toda a UI: canvas, terminais, shell, settings, plugins e efeitos. Não importa electron; fala com o preload ou com o cliente web.',
      detail:
        '1.303 arquivos e 187.483 linhas, 57,7% do src. 22.712 linhas de CSS, 40 animações definidas e 75 usos. O fork alterou 14 arquivos, a maioria em workspace e shell.',
      source: 'src/app/renderer, src/contexts',
      decision: 'Otimizar por camada',
    },
    {
      id: 'c-preload',
      view: 'camadas',
      group: 'Ponte',
      name: 'Preload',
      status: 'base',
      lines: 1349,
      files: 0,
      added: 0,
      removed: 0,
      summary:
        'Expõe 26 namespaces e 137 canais IPC para o renderer. É a fronteira entre a UI e o main.',
      detail:
        '15 arquivos e 1.349 linhas. O fork não alterou o preload, mas o bundle sandboxed precisa manter zod fora, como mostra um commit da branch.',
      source: 'src/app/preload',
      decision: 'Congelar contrato',
    },
    {
      id: 'c-main',
      view: 'camadas',
      group: 'Backend',
      name: 'Electron main',
      status: 'misto',
      lines: 40913,
      files: 50,
      added: 2896,
      removed: 181,
      summary:
        'Janela única, IPC, menus, updater, atalhos, clipboard, website windows e a control surface.',
      detail:
        '315 arquivos e 40.913 linhas, sendo 31.688 em controlSurface/Worker. O fork adicionou handlers orch, grants e operações de sessão.',
      source: 'src/app/main',
      decision: 'Isolar orch do núcleo',
    },
    {
      id: 'c-control',
      view: 'camadas',
      group: 'Backend',
      name: 'Control Surface',
      status: 'fork',
      lines: 31688,
      files: 50,
      added: 2896,
      removed: 181,
      summary:
        'Camada de command, query e event do Worker. É por onde passam CLI, Web UI, plugins e a orquestração.',
      detail:
        '243 arquivos e 31.688 linhas, contando o worker. O fork registrou doze operações orch, grants por projeto e handlers de sessão.',
      source: 'src/app/main/controlSurface',
      decision: 'Manter e versionar',
    },
    {
      id: 'c-worker',
      view: 'camadas',
      group: 'Backend',
      name: 'Worker e PTY host',
      status: 'misto',
      lines: 4241,
      files: 1,
      added: 7,
      removed: 1,
      summary:
        'Backend HTTP/WS, PTY hub, SQLite, providers e processos auxiliares. O PTY host roda em utility process.',
      detail:
        'Worker com 1.058 linhas e PTY host com 3.183. O fork alterou o worker para compor o serviço de orquestração.',
      source: 'src/app/worker, src/platform/process/ptyHost',
      decision: 'Manter',
    },
    {
      id: 'c-sqlite',
      view: 'camadas',
      group: 'Dados',
      name: 'SQLite e persistência',
      status: 'misto',
      lines: 3021,
      files: 7,
      added: 312,
      removed: 1,
      summary:
        'Banco local, migrações, estado do app, scrollback e recuperação. O fork está na versão 14; o upstream está na 15.',
      detail:
        '7 arquivos alterados e 312 linhas adicionadas. As tabelas de orquestração ocupam a versão 14, que no upstream é usada por retomada de sessão e linhagem de nós. É o bloqueio mais grave.',
      source: 'src/platform/persistence/sqlite',
      decision: 'Congelar e reconciliar',
    },
    {
      id: 'c-plugins',
      view: 'camadas',
      group: 'Extensões',
      name: 'Plugin host',
      status: 'base',
      lines: 10169,
      files: 0,
      added: 0,
      removed: 0,
      summary:
        'Instalação, manifest, views em iframe, comandos, skills, temas e backend Node em child process.',
      detail:
        '90 arquivos e 10.169 linhas. A views são HTML e CSS, com SDK injetado. Qualquer UI nativa quebra o contrato.',
      source: 'src/contexts/plugins',
      decision: 'Isolar e medir uso',
    },
    {
      id: 'c-cli',
      view: 'camadas',
      group: 'Borda',
      name: 'CLI',
      status: 'misto',
      lines: 8569,
      files: 3,
      added: 624,
      removed: 149,
      summary:
        'Cliente do Control Surface, com comandos de projeto, sessão, canvas e orquestração.',
      detail:
        '64 arquivos e 8.569 linhas. O fork adicionou comandos orch, dispatch, status e notificações incertas.',
      source: 'src/app/cli',
      decision: 'Manter',
    },

    // Propriedade
    {
      id: 'p-base',
      view: 'propriedade',
      group: 'Base intocada',
      name: 'Main do fork',
      status: 'base',
      lines: 0,
      files: 0,
      added: 0,
      removed: 0,
      summary:
        'O main do fork está no mesmo commit do merge-base com o upstream. Não tem commit próprio e está 99 commits atrás.',
      detail:
        'Merge-base 2cf2710b. O upstream avançou 99 commits desde então. O trabalho do Glimpse não está no main; está na branch docs/orchestration-adr.',
      source: 'git merge-base, git rev-list',
      decision: 'Atualizar antes de qualquer fase',
    },
    {
      id: 'p-branch',
      view: 'propriedade',
      group: 'Fork',
      name: 'Branch docs/orchestration-adr',
      status: 'fork',
      lines: 40129,
      files: 373,
      added: 40129,
      removed: 992,
      summary:
        'Onde vive o trabalho do Glimpse. 47 commits, 373 arquivos, 40.129 linhas adicionadas e 992 removidas.',
      detail:
        'A branch concentra orquestração, agentes, control surface, persistência, CLI, contratos, workspace e testes. É o estado real do produto, não o main.',
      source: 'git diff 2cf2710b..9e1fe4c7',
      decision: 'Reconciliar com upstream',
    },
    {
      id: 'p-orch',
      view: 'propriedade',
      group: 'Fork',
      name: 'Orquestração',
      status: 'fork',
      lines: 6860,
      files: 54,
      added: 7311,
      removed: 0,
      summary:
        'Dispatch, executores, links, notices, aprovações, recuperação e serviços. É o diferencial do fork.',
      detail:
        '54 arquivos alterados e 7.311 linhas adicionadas. Depende de agent, main, workspace, CLI e persistência.',
      source: 'src/contexts/orchestration',
      decision: 'Manter',
    },
    {
      id: 'p-agent',
      view: 'propriedade',
      group: 'Misto',
      name: 'Agentes',
      status: 'misto',
      lines: 19024,
      files: 15,
      added: 601,
      removed: 130,
      summary:
        'Providers, sessões, transcripts, permissões e MCP. O fork corrigiu retomada e aprovações.',
      detail:
        '15 arquivos alterados. A área é compartilhada com o upstream, que também mexeu em retomada de sessão nos mesmos dias.',
      source: 'src/contexts/agent',
      decision: 'Reconciliar e isolar',
    },
    {
      id: 'p-workspace',
      view: 'propriedade',
      group: 'Misto',
      name: 'Workspace e Canvas',
      status: 'misto',
      lines: 97990,
      files: 17,
      added: 174,
      removed: 26,
      summary:
        'Canvas, nós, links de orquestração e ajustes de layout. A base é upstream; o fork adicionou arestas e comportamento.',
      detail:
        '17 arquivos alterados, 174 linhas adicionadas e 26 removidas. É a maior área do código e a mais sensível a conflito.',
      source: 'src/contexts/workspace',
      decision: 'Otimizar e manter',
    },
    {
      id: 'p-settings',
      view: 'propriedade',
      group: 'Misto',
      name: 'Settings',
      status: 'misto',
      lines: 21385,
      files: 5,
      added: 70,
      removed: 0,
      summary:
        'Dezoito páginas de configuração. O fork adicionou preferências de orquestração.',
      detail:
        '5 arquivos alterados e 70 linhas. Muitas opções são raramente usadas e candidatas a poda.',
      source: 'src/contexts/settings',
      decision: 'Podar opções',
    },
    {
      id: 'p-shared',
      view: 'propriedade',
      group: 'Misto',
      name: 'Contratos compartilhados',
      status: 'misto',
      lines: 18488,
      files: 12,
      added: 470,
      removed: 3,
      summary:
        'DTOs, canais IPC, operações do Control Surface e normalizadores. O fork adicionou contratos orch.',
      detail:
        '12 arquivos alterados e 470 linhas. É a fronteira que precisa de teste de contrato em cada merge.',
      source: 'src/shared/contracts',
      decision: 'Versionar e testar',
    },
    {
      id: 'p-terminal',
      view: 'propriedade',
      group: 'Base intocada',
      name: 'Terminal',
      status: 'base',
      lines: 17675,
      files: 0,
      added: 0,
      removed: 0,
      summary:
        'xterm 6, sete addons, WebGL, restauração, geometria e multi-client. O fork não alterou.',
      detail:
        '17.675 linhas de integração, 112 arquivos. É o subsistema mais congelado e o mais caro de substituir.',
      source: 'src/contexts/workspace/.../terminalNode',
      decision: 'Congelar',
    },
    {
      id: 'p-plugins',
      view: 'propriedade',
      group: 'Base intocada',
      name: 'Plugins',
      status: 'base',
      lines: 10169,
      files: 0,
      added: 0,
      removed: 0,
      summary:
        'Views em iframe, temas CSS, backend Node e instalação independente.',
      detail:
        '10.169 linhas e 27 documentos. O fork não alterou. É a área que mais depende do browser.',
      source: 'src/contexts/plugins, docs/plugins',
      decision: 'Isolar',
    },
    {
      id: 'p-website',
      view: 'propriedade',
      group: 'Base intocada',
      name: 'Website nodes',
      status: 'base',
      lines: 3228,
      files: 0,
      added: 0,
      removed: 0,
      summary:
        'Sites embutidos com WebContentsView, posicionados por frame no canvas.',
      detail:
        '2.755 linhas no main e 473 no nó. O fork não alterou. O zoom quebra o mapeamento, segundo o próprio código.',
      source: 'src/app/main/websiteWindow, website node',
      decision: 'Medir uso',
    },
    {
      id: 'p-tests',
      view: 'propriedade',
      group: 'Fork',
      name: 'Testes',
      status: 'fork',
      lines: 285133,
      files: 165,
      added: 23588,
      removed: 294,
      summary:
        'A maior parte do diff. 165 arquivos de teste alterados, com 23.588 linhas adicionadas.',
      detail:
        'O repositório tem 285.133 linhas de teste, 5.961 casos e 2.181 seletores E2E. A branch adicionou testes de orquestração, contratos e E2E reais.',
      source: 'tests',
      decision: 'Manter e usar como rede',
    },
    {
      id: 'p-docs',
      view: 'propriedade',
      group: 'Fork',
      name: 'Documentação',
      status: 'fork',
      lines: 3452,
      files: 21,
      added: 3160,
      removed: 3,
      summary:
        'Cards de orquestração, ADRs e resultados de waves. O fork documentou o próprio processo.',
      detail:
        '21 arquivos alterados e 3.160 linhas. Inclui docs/architecture e docs/knowledge.',
      source: 'docs',
      decision: 'Manter e podar',
    },
    {
      id: 'p-dead',
      view: 'propriedade',
      group: 'Poda',
      name: 'Candidatos a poda',
      status: 'morto',
      lines: 0,
      files: 0,
      added: 0,
      removed: 0,
      summary:
        'react-router-dom sem imports, parser de diff sem uso, dependências declaradas sem uso e opções de settings raramente abertas.',
      detail:
        'Tailwind está ativo no Vite, então não é candidato. A poda precisa de verificação de uso no build e deve ir como PR para o upstream, não só no fork.',
      source: 'package.json, electron.vite.config.ts, grep',
      decision: 'Podar com verificação',
    },

    // Riscos
    {
      id: 'r-schema',
      view: 'riscos',
      group: 'Alto',
      name: 'Colisão de schema',
      status: 'risco',
      lines: 0,
      files: 7,
      added: 312,
      removed: 0,
      summary:
        'O fork está na versão 14 do banco; o upstream está na 15. As tabelas de orquestração ocupam a mesma faixa da migração de sessão do upstream.',
      detail:
        'Os dados locais são de teste e podem ser recriados, então o risco não é perder histórico: é a migração rodar errada e o merge parar. Mitigação: separar o banco da orquestração, congelar schema e testar a migração.',
      source: 'DB_SCHEMA_VERSION, src/platform/persistence/sqlite',
      decision: 'Semana 0, separar o banco',
    },
    {
      id: 'r-merge',
      view: 'riscos',
      group: 'Crítico',
      name: 'Divergência e merge',
      status: 'risco',
      lines: 0,
      files: 373,
      added: 40129,
      removed: 992,
      summary:
        'O upstream avança cerca de 16 commits por dia. A branch tem 47 commits e 373 arquivos. O custo passa a ser medido em conflitos, portões e tempo de agente.',
      detail:
        'O main do fork está 99 commits atrás e sem divergência. O merge semanal passa a ser executado por agente, em três classes. Sem isso, a divergência cresce mais rápido que a capacidade de reconciliar.',
      source: 'git rev-list, git diff',
      decision: 'Primeiro merge por agente',
    },
    {
      id: 'r-dados',
      view: 'riscos',
      group: 'Médio',
      name: 'Pasta de dados e marca',
      status: 'risco',
      lines: 0,
      files: 1,
      added: 0,
      removed: 0,
      summary:
        'O produto ainda se chama OpenCove e usa appId dev.deadwave.opencove. O app oficial não está instalado e o perfil local é de teste, então o risco só aparece se o Glimpse for distribuído.',
      detail:
        'Mitigação: se distribuir, isolar userData, appId, productName e canal de update. Se for local, manter o perfil separado e documentar.',
      source: 'package.json, appRuntimeConfig.ts',
      decision: 'Só se distribuir',
    },
    {
      id: 'r-terminal',
      view: 'riscos',
      group: 'Alto',
      name: 'Paridade de terminal',
      status: 'risco',
      lines: 17675,
      files: 0,
      added: 0,
      removed: 0,
      summary:
        'xterm 6 com sete addons, patch WebGL, geometria canônica, multi-client e restauração. Qualquer mudança pode perder scrollback.',
      detail:
        'Mitigação: congelar o subsistema, exigir teste de TUI, multi-client e recuperação. Não trocar o emulador.',
      source: 'terminalNode, docs/terminal',
      decision: 'Congelar',
    },
    {
      id: 'r-plugins',
      view: 'riscos',
      group: 'Alto',
      name: 'Plugins e webview',
      status: 'risco',
      lines: 10169,
      files: 0,
      added: 0,
      removed: 0,
      summary:
        'Views em iframe HTML/CSS e temas CSS. Uma UI nativa quebraria o contrato; manter webview traz o browser e dois sistemas de estilo.',
      detail:
        'Mitigação: manter a plataforma, isolar o contrato e medir uso real antes de qualquer mudança estrutural.',
      source: 'src/contexts/plugins, docs/plugins',
      decision: 'Isolar',
    },
    {
      id: 'r-duplicacao',
      view: 'riscos',
      group: 'Alto',
      name: 'Duplicação de correções',
      status: 'risco',
      lines: 0,
      files: 2,
      added: 0,
      removed: 0,
      summary:
        'O fork está 99 commits atrás. Correções feitas no fork podem já existir no upstream, com outra mensagem e outro SHA.',
      detail:
        'O commit c05a3964 do Bruno, de 2026-11-13, corrige o mesmo sintoma do b0c14242 do upstream, de 2026-11-08: agente novo tratado como restaurado e terminal esperando saída. Mitigação: merge semanal e busca no upstream antes de cada correção.',
      source: 'git log, c05a3964, b0c14242',
      decision: 'Merge semanal e busca antes de corrigir',
    },
    {
      id: 'r-motion',
      view: 'riscos',
      group: 'Médio',
      name: 'Motion artesanal',
      status: 'risco',
      lines: 22712,
      files: 23,
      added: 0,
      removed: 0,
      summary:
        '40 animações definidas em 23 arquivos, 75 usos, 46 backdrop-filter, 184 sombras e 62 filtros. Não há sistema de tokens.',
      detail:
        'Mitigação: inventariar por definição, classificar por custo, tokens CSS para hover/press/foco, lib só para presença e springs, metas por frames perdidos.',
      source: 'src/**/*.css',
      decision: 'Sistema em ondas',
    },
    {
      id: 'r-perf',
      view: 'riscos',
      group: 'Médio',
      name: 'Performance sem atribuição',
      status: 'risco',
      lines: 0,
      files: 2,
      added: 0,
      removed: 0,
      summary:
        'O app tem monitor, mas não atribuição por causa. A suíte tests/perf existe e não foi usada como baseline.',
      detail:
        'Mitigação: adotar tests/perf, medir frames perdidos e trabalho por frame, registrar hardware e GPU, e só agir sobre culpado medido.',
      source: 'tests/perf, performance monitor',
      decision: 'Baseline antes de otimizar',
    },
    {
      id: 'r-poda',
      view: 'riscos',
      group: 'Médio',
      name: 'Poda com conflito',
      status: 'risco',
      lines: 0,
      files: 0,
      added: 0,
      removed: 0,
      summary:
        'Tailwind está ativo no build. Remover dependência sem verificar o empacotador gera conflito e pode quebrar CSS.',
      detail:
        'Mitigação: podar em PRs pequenos, verificar imports dinâmicos e build, e enviar a remoção ao upstream quando for genérica.',
      source: 'package.json, electron.vite.config.ts',
      decision: 'Poda incremental',
    },
  ];

  const relations = [
    { from: 'g-canvas', to: 'c-renderer', label: 'vive no' },
    { from: 'g-terminal', to: 'c-worker', label: 'usa PTY' },
    { from: 'g-orch', to: 'g-terminal', label: 'dispara agentes' },
    { from: 'g-orch', to: 'c-control', label: 'expõe comandos' },
    { from: 'c-control', to: 'c-main', label: 'roda no' },
    { from: 'c-main', to: 'c-worker', label: 'fala com' },
    { from: 'c-worker', to: 'c-sqlite', label: 'persiste em' },
    { from: 'g-ext', to: 'c-plugins', label: 'depende de' },
    { from: 'g-ext', to: 'c-renderer', label: 'renderiza no' },
    { from: 'c-cli', to: 'c-control', label: 'chama' },
    { from: 'r-schema', to: 'c-sqlite', label: 'ameaça' },
    { from: 'r-merge', to: 'p-branch', label: 'cresce com' },
    { from: 'r-duplicacao', to: 'p-agent', label: 'afeta' },
  ];

  window.GLIMPSE = { meta, views, nodes, relations };
})();
