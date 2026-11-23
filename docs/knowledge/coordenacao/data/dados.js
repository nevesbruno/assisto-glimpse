window.MESA = {
  meta: {
    produto: "Glimpse",
    titulo: "Coordenação",
    descricao: "Mesa de coordenação de projetos e agentes",
    atualizado: "20 nov 2026, 14:25",
    notaRodape: "Protótipo estático, dados de exemplo. Nenhuma ação altera o repositório.",
    atalhos: [
      { tecla: "/", acao: "buscar" },
      { tecla: "Esc", acao: "fechar detalhe" }
    ],
    views: [
      {
        id: "agora",
        rotulo: "Agora",
        pergunta: "O que roda, o que espera, o que trava e o que precisa de você."
      },
      {
        id: "projetos",
        rotulo: "Projetos",
        pergunta: "Quais projetos estão saudáveis e qual está travado."
      },
      {
        id: "fila",
        rotulo: "Fila",
        pergunta: "O que começa a seguir e o que está esperando o quê."
      },
      {
        id: "upstream",
        rotulo: "Upstream",
        pergunta: "O merge é trabalho do agente, não do Bruno."
      }
    ]
  },

  projetos: [
    {
      id: "glimpse",
      nome: "Glimpse",
      descricao: "Workspace de agentes",
      cor: "#147a6b",
      branch: "docs/orchestration-adr",
      wip: "4 de 4",
      fila: 2,
      merge: "99 atrás",
      saude: "atencao",
      saudeTexto: "Atenção, merge travado",
      saudeMotivo: "merge do upstream parado no portão de schema",
      ultimoMovimento: "14:22, teste E2E de aprovação MCP em andamento."
    },
    {
      id: "assisto",
      nome: "Assisto",
      descricao: "TTS local",
      cor: "#2f5fa8",
      branch: "main",
      wip: "1 de 3",
      fila: 1,
      merge: "em dia",
      saude: "ok",
      saudeTexto: "Saudável",
      saudeMotivo: "sem pendência de merge",
      ultimoMovimento: "14:12, perfil de 200 amostras de voz concluído."
    },
    {
      id: "automacoes",
      nome: "Automações",
      descricao: "Rotinas e agentes",
      cor: "#9a6a00",
      branch: "main",
      wip: "2 de 2",
      fila: 1,
      merge: "em dia",
      saude: "ok",
      saudeTexto: "Saudável",
      saudeMotivo: "sem pendência de merge",
      ultimoMovimento: "14:12, autorização de limpeza de 14 GB pedida."
    }
  ],

  execucoes: [
    {
      id: "r-orq",
      projeto: "glimpse",
      agente: "Claude Code",
      provedor: "Anthropic",
      titulo: "Retomada de executor após crash",
      estado: "executando",
      tempo: "42 min",
      evento: "Teste de integração passou",
      tokens: "1,2 M",
      inicio: "13:40",
      custo: "US$ 5,40",
      fazendo: "Roda a suíte E2E do fluxo de aprovação depois de retomar o executor. Nenhuma decisão pendente agora.",
      timeline: [
        { hora: "13:50", texto: "Executor reiniciado" },
        { hora: "14:10", texto: "Teste de integração passou" },
        { hora: "14:22", texto: "Rodando E2E" }
      ]
    },
    {
      id: "r-merge",
      projeto: "glimpse",
      agente: "Codex",
      provedor: "OpenAI",
      titulo: "Merge do upstream: 99 commits",
      estado: "bloqueado",
      tempo: "18 min",
      evento: "Conflito em migration: versão 14",
      tokens: "380 mil",
      inicio: "13:42",
      custo: "US$ 1,10",
      fazendo: "Parou no portão de schema. O conflito está na migration v14 e precisa de decisão humana para seguir.",
      timeline: [
        { hora: "13:42", texto: "Detectou 99 commits" },
        { hora: "13:51", texto: "Conflito em src/platform/persistence" },
        { hora: "13:58", texto: "Parou no portão de schema" },
        { hora: "agora", texto: "Aguarda decisão" }
      ]
    },
    {
      id: "r-motion",
      projeto: "glimpse",
      agente: "Claude Code",
      provedor: "Anthropic",
      titulo: "Tokens de animação: hover e foco",
      estado: "revisao",
      tempo: "26 min",
      evento: "PR 412 aberto",
      tokens: "210 mil",
      inicio: "12:30",
      custo: "US$ 0,95",
      fazendo: "Terminou os tokens de motion e abriu o PR 412. Aguarda revisão de código.",
      timeline: [
        { hora: "12:30", texto: "Tokens mapeados" },
        { hora: "13:20", texto: "PR 412 aberto" },
        { hora: "agora", texto: "Aguarda revisão" }
      ]
    },
    {
      id: "r-mcp",
      projeto: "glimpse",
      agente: "Codex",
      provedor: "OpenAI",
      titulo: "Testes E2E de aprovação MCP",
      estado: "executando",
      tempo: "12 min",
      evento: "3 de 5 cenários",
      tokens: "95 mil",
      inicio: "14:10",
      custo: "US$ 0,40",
      fazendo: "Executa o terceiro de cinco cenários E2E de aprovação MCP.",
      timeline: [
        { hora: "14:10", texto: "Executor Codex iniciado" },
        { hora: "14:16", texto: "Cenários 1 e 2 aprovados" },
        { hora: "14:20", texto: "Cenário 3 de 5 em curso" }
      ]
    },
    {
      id: "r-voz",
      projeto: "assisto",
      agente: "Claude Code",
      provedor: "Anthropic",
      titulo: "Latência da transcrição de voz",
      estado: "executando",
      tempo: "1 h 07",
      evento: "Perfil de 200 amostras",
      tokens: "2,4 M",
      inicio: "13:15",
      custo: "US$ 8,60",
      fazendo: "Coleta o perfil de latência em 200 amostras antes de propor ajuste no pipeline.",
      timeline: [
        { hora: "13:15", texto: "Perfil de latência iniciado" },
        { hora: "13:48", texto: "120 amostras coletadas" },
        { hora: "14:12", texto: "200 amostras coletadas" },
        { hora: "14:20", texto: "Análise em andamento" }
      ]
    },
    {
      id: "r-avaliacao",
      projeto: "assisto",
      agente: "Codex",
      provedor: "OpenAI",
      titulo: "Avaliação de vozes pt-BR",
      estado: "fila",
      tempo: "na fila",
      evento: "Aguardando r-voz",
      tokens: "0",
      inicio: "não iniciou",
      custo: "US$ 0,00",
      fazendo: "Aguardando r-voz terminar para comparar as vozes com o perfil novo.",
      timeline: [
        { hora: "13:30", texto: "Entrou na fila" },
        { hora: "13:30", texto: "Depende de r-voz" },
        { hora: "agora", texto: "Aguarda liberação" }
      ]
    },
    {
      id: "r-norm",
      projeto: "assisto",
      agente: "Claude Code",
      provedor: "Anthropic",
      titulo: "Normalização de texto falada",
      estado: "concluido",
      tempo: "34 min",
      evento: "Concluído às 12:20",
      tokens: "180 mil",
      inicio: "11:46",
      custo: "US$ 0,80",
      fazendo: "Concluído sem pendências. O resultado está no PR de normalização.",
      timeline: [
        { hora: "11:46", texto: "Normalização iniciada" },
        { hora: "11:58", texto: "412 trechos revisados" },
        { hora: "12:08", texto: "1.284 trechos revisados" },
        { hora: "12:20", texto: "Concluído com zero falhas" }
      ]
    },
    {
      id: "r-cache",
      projeto: "automacoes",
      agente: "Codex",
      provedor: "OpenAI",
      titulo: "Limpeza de caches do ambiente",
      estado: "aguardando",
      tempo: "6 min",
      evento: "Pede autorização para apagar 14 GB",
      tokens: "12 mil",
      inicio: "14:08",
      custo: "US$ 0,06",
      fazendo: "Mapeou 14 GB e parou antes de apagar qualquer arquivo. Precisa de autorização.",
      timeline: [
        { hora: "14:10", texto: "Mapeou 14 GB" },
        { hora: "14:12", texto: "Pediu autorização" },
        { hora: "14:13", texto: "Nenhum arquivo apagado" }
      ]
    },
    {
      id: "r-rotina",
      projeto: "automacoes",
      agente: "Claude Code",
      provedor: "Anthropic",
      titulo: "Rotina de avaliação a cada 2 dias",
      estado: "fila",
      tempo: "na fila",
      evento: "Aguardando r-cache",
      tokens: "0",
      inicio: "não iniciou",
      custo: "US$ 0,00",
      fazendo: "Aguardando r-cache para não agendar rotina sobre cache sujo.",
      timeline: [
        { hora: "13:20", texto: "Entrou na fila" },
        { hora: "13:20", texto: "Depende de r-cache" },
        { hora: "agora", texto: "Aguarda autorização" }
      ]
    },
    {
      id: "r-relatorio",
      projeto: "automacoes",
      agente: "Codex",
      provedor: "OpenAI",
      titulo: "Relatório de uso dos agentes",
      estado: "falhou",
      tempo: "22 min",
      evento: "Provider sem crédito",
      tokens: "45 mil",
      inicio: "13:58",
      custo: "US$ 0,22",
      fazendo: "Interrompido pelo provider sem crédito. Nenhum dado foi perdido.",
      timeline: [
        { hora: "13:58", texto: "Coleta iniciada" },
        { hora: "14:08", texto: "7 de 12 fontes lidas" },
        { hora: "14:16", texto: "Provider recusou a chamada" },
        { hora: "14:20", texto: "Execução interrompida por falta de crédito" }
      ]
    }
  ],

  fila: [
    {
      id: "q-poda",
      projeto: "glimpse",
      titulo: "Poda de dependências sem uso",
      prioridade: "alta",
      agente: "Codex",
      dependencia: null,
      estado: "pronta",
      detalhe: "Remove pacotes sem importação. Sem risco de contrato."
    },
    {
      id: "q-docs",
      projeto: "glimpse",
      titulo: "Atualizar FORK.md",
      prioridade: "baixa",
      agente: "Claude Code",
      dependencia: null,
      estado: "pronta",
      detalhe: "Documenta a branch docs/orchestration-adr."
    },
    {
      id: "q-avaliacao",
      projeto: "assisto",
      titulo: "Avaliação de vozes pt-BR",
      prioridade: "media",
      agente: "Codex",
      dependencia: "r-voz",
      estado: "esperando",
      detalhe: "Compara vozes com o perfil de latência novo."
    },
    {
      id: "q-rotina",
      projeto: "automacoes",
      titulo: "Rotina de avaliação a cada 2 dias",
      prioridade: "media",
      agente: "Claude Code",
      dependencia: "r-cache",
      estado: "esperando",
      detalhe: "Agenda a rotina só depois da limpeza de cache."
    }
  ],

  atencao: [
    {
      id: "a-schema",
      tipo: "Aprovação",
      pergunta: "Aprovar merge de classe B (schema v14)",
      projeto: "glimpse",
      idade: "18 min",
      alvo: { tipo: "execucao", id: "r-merge" }
    },
    {
      id: "a-cache",
      tipo: "Autorização",
      pergunta: "Autorizar limpeza de 14 GB",
      projeto: "automacoes",
      idade: "6 min",
      alvo: { tipo: "execucao", id: "r-cache" }
    },
    {
      id: "a-motion",
      tipo: "Revisão",
      pergunta: "Revisar PR de motion",
      projeto: "glimpse",
      idade: "1 h",
      alvo: { tipo: "execucao", id: "r-motion" }
    },
    {
      id: "a-update",
      tipo: "Decisão",
      pergunta: "Definir canal de atualização",
      projeto: "glimpse",
      idade: "1 dia",
      alvo: { tipo: "projeto", id: "glimpse" }
    }
  ],

  upstream: {
    atras: 99,
    ultimoMerge: "nunca",
    proximo: "segunda, 09:00",
    agente: "merge-upstream",
    resultado: "não rodou",
    resumo: "O fork está 99 commits atrás. O último merge nunca rodou e a próxima janela é segunda, 09:00.",
    nota: "O merge é trabalho do agente merge-upstream. Você decide a classe B. A classe C para e entrega diagnóstico.",
    portoes: [
      {
        id: "schema",
        nome: "Schema",
        detalhe: "Migration 14 do fork contra 15 do upstream",
        estado: "não rodou"
      },
      {
        id: "contratos",
        nome: "Contratos",
        detalhe: "IPC, tipos do preload e canais compartilhados",
        estado: "não rodou"
      },
      {
        id: "e2e",
        nome: "E2E",
        detalhe: "Canvas, terminal e fluxo de aprovação",
        estado: "não rodou"
      }
    ],
    classes: [
      {
        classe: "A",
        nome: "Automática",
        texto: "Conflito mecânico, sem schema, contrato, terminal ou persistência. O agente resolve, roda os portões e faz o merge do próprio PR."
      },
      {
        classe: "B",
        nome: "Revisão",
        texto: "Toca schema, contrato, terminal ou persistência. O agente prepara a branch e o relatório, e aguarda aprovação humana."
      },
      {
        classe: "C",
        nome: "Parada",
        texto: "Conflito que o agente não entende, ou portão que falhou duas vezes. O agente para, não faz merge e entrega o diagnóstico."
      }
    ]
  }
};
