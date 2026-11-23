(function () {
  "use strict";

  const MESA = window.MESA;
  if (!MESA) {
    return;
  }

  const UI = (window.MesaCoord = window.MesaCoord || {});

  const ESTADOS = {
    executando: { rotulo: "Executando", classe: "state-executando" },
    aguardando: { rotulo: "Aguardando", classe: "state-aguardando" },
    bloqueado: { rotulo: "Bloqueado", classe: "state-bloqueado" },
    revisao: { rotulo: "Revisão", classe: "state-revisao" },
    concluido: { rotulo: "Concluído", classe: "state-concluido" },
    fila: { rotulo: "Fila", classe: "state-fila" },
    falhou: { rotulo: "Falhou", classe: "state-falhou" }
  };

  const PRIORIDADES = {
    alta: { rotulo: "Alta", ordem: 0, classe: "priority-alta" },
    media: { rotulo: "Média", ordem: 1, classe: "priority-media" },
    baixa: { rotulo: "Baixa", ordem: 2, classe: "priority-baixa" }
  };

  const ACOES_POR_ESTADO = {
    executando: [{ id: "pause", rotulo: "Pausar", tipo: "secondary" }],
    aguardando: [{ id: "approve", rotulo: "Aprovar", tipo: "primary" }],
    bloqueado: [{ id: "approve", rotulo: "Aprovar", tipo: "primary" }],
    revisao: [
      { id: "rerun", rotulo: "Reexecutar", tipo: "secondary" },
      { id: "approve", rotulo: "Aprovar", tipo: "primary" }
    ],
    concluido: [{ id: "rerun", rotulo: "Reexecutar", tipo: "primary" }],
    fila: [{ id: "dispatch", rotulo: "Despachar", tipo: "primary" }],
    falhou: [{ id: "rerun", rotulo: "Reexecutar", tipo: "primary" }]
  };

  const state = {
    view: "agora",
    query: "",
    aberto: null,
    resolvidos: new Set(),
    ultimoFoco: null,
    pedirAtencao: false,
    realcarProjeto: null,
    toastTimer: null
  };

  const projetoPorId = new Map(MESA.projetos.map((p) => [p.id, p]));
  const execucaoPorId = new Map(MESA.execucoes.map((e) => [e.id, e]));

  const viewEl = document.getElementById("view");
  const buscaEl = document.getElementById("busca");
  const tabsEl = document.getElementById("tabs");
  const statsEl = document.getElementById("stats");
  const questionEl = document.getElementById("view-question");
  const countEl = document.getElementById("view-count");
  const chipEl = document.getElementById("attention-chip");
  const footEl = document.getElementById("page-foot");
  const drawerEl = document.getElementById("drawer");
  const drawerCloseEl = document.getElementById("drawer-close");
  const drawerTitleEl = document.getElementById("drawer-title");
  const drawerKickerEl = document.getElementById("drawer-kicker");
  const drawerSubEl = document.getElementById("drawer-sub");
  const drawerBodyEl = document.getElementById("drawer-body");
  const drawerActionsEl = document.getElementById("drawer-actions");
  const scrimEl = document.getElementById("scrim");
  const toastEl = document.getElementById("toast");

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function normalizar(valor) {
    return String(valor)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
  }

  function contem(termo, valores) {
    const alvo = normalizar(termo);
    return valores.some((valor) => valor != null && normalizar(valor).includes(alvo));
  }

  function listaNomes(projetos) {
    const nomes = projetos.map((p) => p.nome);
    if (nomes.length <= 1) return nomes.join("");
    if (nomes.length === 2) return `${nomes[0]} e ${nomes[1]}`;
    return `${nomes.slice(0, -1).join(", ")} e ${nomes[nomes.length - 1]}`;
  }

  function plural(n, singular, pluralForma) {
    return n === 1 ? singular : pluralForma;
  }

  function atencaoAtiva() {
    return MESA.atencao.filter((a) => !state.resolvidos.has(a.id));
  }

  function execucoesAtivas() {
    return MESA.execucoes.filter((e) => e.estado === "executando");
  }

  function minutosDaIdade(idade) {
    const numero = parseInt(idade, 10);
    if (!Number.isFinite(numero)) return 0;
    if (idade.includes("dia")) return numero * 1440;
    if (idade.includes("h")) return numero * 60;
    return numero;
  }

  function atencaoMaisAntiga(itens) {
    return itens.reduce((maisVelha, item) => {
      if (!maisVelha) return item;
      return minutosDaIdade(item.idade) > minutosDaIdade(maisVelha.idade) ? item : maisVelha;
    }, null);
  }

  function viewAtual() {
    const ids = MESA.meta.views.map((v) => v.id);
    const bruto = window.location.hash.replace(/^#\/?/, "").split("?")[0];
    return ids.includes(bruto) ? bruto : "agora";
  }

  function casarExecucao(exec, termo) {
    const projeto = projetoPorId.get(exec.projeto);
    return contem(termo, [
      exec.titulo,
      exec.agente,
      exec.provedor,
      exec.id,
      projeto ? projeto.nome : ""
    ]);
  }

  function casarAtencao(item, termo) {
    const projeto = projetoPorId.get(item.projeto);
    return contem(termo, [item.tipo, item.pergunta, item.projeto, projeto ? projeto.nome : ""]);
  }

  function casarFila(item, termo) {
    const projeto = projetoPorId.get(item.projeto);
    return contem(termo, [item.titulo, item.agente, item.projeto, projeto ? projeto.nome : ""]);
  }

  function casarProjeto(projeto, termo) {
    const execs = MESA.execucoes.filter((e) => e.projeto === projeto.id);
    const fila = MESA.fila.filter((f) => f.projeto === projeto.id);
    const valores = [
      projeto.nome,
      projeto.descricao,
      projeto.branch,
      projeto.id,
      projeto.saudeTexto
    ];
    execs.forEach((e) => valores.push(e.titulo, e.agente));
    fila.forEach((f) => valores.push(f.titulo, f.agente));
    return contem(termo, valores);
  }

  function casarUpstream(termo) {
    const up = MESA.upstream;
    const valores = [
      "upstream",
      "merge",
      up.agente,
      up.resultado,
      up.proximo,
      up.ultimoMerge,
      up.resumo,
      up.nota,
      String(up.atras)
    ];
    up.portoes.forEach((p) => valores.push(p.nome, p.detalhe));
    up.classes.forEach((c) => valores.push(c.nome, c.texto, c.classe));
    return contem(termo, valores);
  }

  function criarPilulaEstado(estado) {
    const info = ESTADOS[estado];
    const pill = el("span", `state-pill ${info.classe}`, info.rotulo);
    return pill;
  }

  function construirChrome() {
    const brand = document.getElementById("brand");
    brand.replaceChildren();
    const marca = el("span", "brand-mark");
    marca.setAttribute("aria-hidden", "true");
    brand.appendChild(marca);
    brand.appendChild(el("span", null, MESA.meta.produto));
    brand.setAttribute("aria-label", `${MESA.meta.produto}. Ir para a visão Agora.`);

    document.getElementById("app-title").textContent = MESA.meta.titulo;

    tabsEl.replaceChildren();
    MESA.meta.views.forEach((view) => {
      const link = el("a", "tab", view.rotulo);
      link.href = `#/${view.id}`;
      link.dataset.view = view.id;
      tabsEl.appendChild(link);
    });

    footEl.replaceChildren();
    footEl.appendChild(el("span", null, MESA.meta.notaRodape));
    footEl.appendChild(el("span", null, `Dados de exemplo, atualizado em ${MESA.meta.atualizado}.`));
  }

  function criarStat(opcoes) {
    const no = document.createElement(opcoes.tag || "a");
    no.className = `stat ${opcoes.classe}`;
    if (opcoes.href) no.href = opcoes.href;
    if (opcoes.tag === "button") no.type = "button";
    if (opcoes.rotuloAria) no.setAttribute("aria-label", opcoes.rotuloAria);

    no.appendChild(el("span", "stat-number", opcoes.numero));
    const copia = el("span", "stat-copy");
    copia.appendChild(el("span", "stat-label", opcoes.rotulo));
    copia.appendChild(el("span", "stat-hint", opcoes.dica));
    no.appendChild(copia);

    if (opcoes.aoClicar) no.addEventListener("click", opcoes.aoClicar);
    return no;
  }

  function renderizarChrome() {
    const ativos = execucoesAtivas();
    const projetosAtivos = new Set(ativos.map((e) => e.projeto));
    const fila = MESA.fila;
    const prontas = fila.filter((f) => f.estado === "pronta").length;
    const esperando = fila.length - prontas;
    const atencao = atencaoAtiva();
    const maisAntiga = atencaoMaisAntiga(atencao);

    statsEl.replaceChildren(
      criarStat({
        tag: "a",
        href: "#/agora",
        classe: "stat-ativas",
        numero: ativos.length,
        rotulo: "execuções ativas",
        dica: `em ${projetosAtivos.size} ${plural(projetosAtivos.size, "projeto", "projetos")}`,
        rotuloAria: `${ativos.length} execuções ativas em ${projetosAtivos.size} projetos`
      }),
      criarStat({
        tag: "a",
        href: "#/fila",
        classe: "stat-fila",
        numero: fila.length,
        rotulo: "na fila",
        dica: `${prontas} ${plural(prontas, "pronta", "prontas")}, ${esperando} esperando`,
        rotuloAria: `${fila.length} itens na fila, ${prontas} prontos e ${esperando} esperando`
      }),
      criarStat({
        tag: "button",
        classe: "stat-atencao",
        numero: atencao.length,
        rotulo: "precisam de você",
        dica: maisAntiga ? `mais antiga há ${maisAntiga.idade}` : "nada pendente",
        rotuloAria: `${atencao.length} pedidos precisam de você. Abrir a lista.`,
        aoClicar: () => UI.focarAtencao()
      }),
      criarStat({
        tag: "a",
        href: "#/upstream",
        classe: "stat-upstream",
        numero: MESA.upstream.atras,
        rotulo: "commits atrás do upstream",
        dica: `${MESA.upstream.agente}, ${MESA.upstream.proximo}`,
        rotuloAria: `${MESA.upstream.atras} commits atrás do upstream`
      })
    );

    chipEl.replaceChildren();
    chipEl.classList.toggle("is-clear", atencao.length === 0);
    const ponto = el("span", "chip-dot");
    ponto.setAttribute("aria-hidden", "true");
    chipEl.appendChild(ponto);
    chipEl.appendChild(el("strong", null, atencao.length));
    chipEl.appendChild(
      el("span", null, atencao.length === 1 ? " precisa de você" : " precisam de você")
    );
    chipEl.setAttribute(
      "aria-label",
      atencao.length === 0
        ? "Nada precisa de você agora. Abrir a lista de atenção."
        : `${atencao.length} pedidos precisam de você. Abrir a lista de atenção.`
    );

    tabsEl.querySelectorAll(".tab").forEach((tab) => {
      if (tab.dataset.view === state.view) {
        tab.setAttribute("aria-current", "page");
      } else {
        tab.removeAttribute("aria-current");
      }
    });
  }

  function definirContagem(texto) {
    countEl.replaceChildren();
    countEl.appendChild(el("span", null, texto));
    if (state.query) {
      const limpar = el("button", "clear-search", "Limpar");
      limpar.type = "button";
      limpar.dataset.clear = "true";
      limpar.setAttribute("aria-label", "Limpar busca");
      limpar.addEventListener("click", () => UI.limparBusca());
      countEl.appendChild(limpar);
    }
  }

  function vazioDeBusca() {
    const caixa = el("div", "empty-wide");
    caixa.appendChild(el("h2", "empty-title", "Nenhum resultado"));
    caixa.appendChild(
      el("p", "empty-copy", `Nada corresponde a "${state.query}" nesta visão.`)
    );
    const botao = el("button", "btn btn-secondary", "Limpar busca");
    botao.type = "button";
    botao.addEventListener("click", () => UI.limparBusca());
    caixa.appendChild(botao);
    return caixa;
  }

  function renderizarAgora() {
    const termo = state.query;
    const atencao = termo ? atencaoAtiva().filter((a) => casarAtencao(a, termo)) : atencaoAtiva();
    const execs = termo ? MESA.execucoes.filter((e) => casarExecucao(e, termo)) : MESA.execucoes;
    const upCombina = termo ? casarUpstream(termo) : false;
    const total = execs.length + atencao.length + (termo && upCombina ? 1 : 0);
    const atencaoTotal = atencaoAtiva().length;

    if (termo) {
      definirContagem(`${total} ${plural(total, "resultado", "resultados")}`);
    } else {
      definirContagem(
        `${MESA.execucoes.length} execuções · ${atencaoTotal} ${plural(
          atencaoTotal,
          "pedido aberto",
          "pedidos abertos"
        )}`
      );
    }

    if (termo && total === 0) {
      viewEl.replaceChildren(vazioDeBusca());
      return;
    }

    const grade = el("section", "agora");
    const board = el("div", "board");
    board.setAttribute("aria-label", "Execuções por projeto");

    MESA.projetos.forEach((projeto) => {
      const doProjeto = execs.filter((e) => e.projeto === projeto.id);
      const filaProjeto = MESA.fila
        .filter((f) => f.projeto === projeto.id)
        .filter((f) => !termo || casarFila(f, termo));

      const coluna = el("article", "project-col");
      coluna.dataset.project = projeto.id;
      coluna.style.setProperty("--project", projeto.cor);
      coluna.appendChild(cabecalhoProjeto(projeto));

      const lista = el("div", "exec-list");
      if (doProjeto.length === 0) {
        lista.appendChild(
          el(
            "p",
            "col-empty",
            termo ? "Nenhuma execução corresponde à busca." : "Nenhuma execução neste projeto."
          )
        );
      } else {
        doProjeto.forEach((exec) => lista.appendChild(cartaoExecucao(exec)));
      }
      coluna.appendChild(lista);
      if (!termo || filaProjeto.length > 0) {
        coluna.appendChild(rodapeFilaProjeto(projeto, filaProjeto));
      }
      board.appendChild(coluna);
    });

    if (termo && execs.length === 0) {
      board.replaceChildren(
        el(
          "p",
          "col-empty",
          "Nenhuma execução corresponde. Os pedidos que restam estão na trilha."
        )
      );
    }

    const rail = el("aside", "rail");
    rail.setAttribute("aria-label", "Atenção e upstream");
    rail.appendChild(painelAtencao(atencao));
    rail.appendChild(cartaoUpstreamMini());
    const dica = el("div", "rail-hint");
    MESA.meta.atalhos.forEach((atalho) => {
      const item = el("span");
      item.appendChild(el("kbd", null, atalho.tecla));
      item.appendChild(document.createTextNode(atalho.acao));
      dica.appendChild(item);
    });
    rail.appendChild(dica);

    grade.append(board, rail);
    viewEl.replaceChildren(grade);

    if (state.realcarProjeto) {
      const id = state.realcarProjeto;
      state.realcarProjeto = null;
      realcarCartaoProjeto(id);
    }
    if (state.pedirAtencao) {
      state.pedirAtencao = false;
      UI.focarAtencao();
    }
  }

  function cabecalhoProjeto(projeto) {
    const head = el("header", "project-head");
    const linha = el("div", "project-title-row");
    const ponto = el("span", "project-dot");
    ponto.style.background = projeto.cor;
    ponto.setAttribute("aria-hidden", "true");
    linha.appendChild(ponto);
    linha.appendChild(el("h2", "project-name", projeto.nome));
    linha.appendChild(
      el(
        "span",
        `health ${projeto.saude === "ok" ? "health-ok" : "health-atencao"}`,
        projeto.saudeTexto
      )
    );
    head.appendChild(linha);

    const sub = el("div", "project-sub");
    sub.appendChild(el("span", "project-desc", projeto.descricao));
    const branch = el("span", "project-branch", projeto.branch);
    branch.title = projeto.branch;
    sub.appendChild(branch);
    head.appendChild(sub);

    const facts = el("dl", "project-facts");
    facts.appendChild(fatoProjeto("WIP", projeto.wip));
    facts.appendChild(fatoProjeto("Fila", projeto.fila));
    facts.appendChild(fatoProjeto("Merge", projeto.merge));
    head.appendChild(facts);
    return head;
  }

  function fatoProjeto(rotulo, valor) {
    const item = el("div", "project-fact");
    item.appendChild(el("dt", null, rotulo));
    item.appendChild(el("dd", null, valor));
    return item;
  }

  function cartaoExecucao(exec) {
    const info = ESTADOS[exec.estado];
    const projeto = projetoPorId.get(exec.projeto);
    const card = el("article", `exec-card ${info.classe}`);
    card.dataset.exec = exec.id;
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.setAttribute(
      "aria-label",
      `Abrir detalhe de ${exec.titulo}, ${info.rotulo}, projeto ${projeto.nome}, agente ${exec.agente}, ${exec.tempo}`
    );

    const topo = el("div", "exec-top");
    topo.appendChild(el("h3", "exec-title", exec.titulo));
    topo.appendChild(criarPilulaEstado(exec.estado));
    card.appendChild(topo);

    const meta = el("div", "exec-meta");
    const agente = el("span", "exec-agent");
    agente.appendChild(el("strong", null, exec.agente));
    agente.appendChild(document.createTextNode(` · ${exec.provedor}`));
    meta.appendChild(agente);
    card.appendChild(meta);

    const evento = el("div", "exec-event");
    evento.appendChild(el("span", "exec-label", "último evento"));
    const valorEvento = el("span", "exec-event-value", exec.evento);
    valorEvento.title = exec.evento;
    evento.appendChild(valorEvento);
    card.appendChild(evento);

    const metrics = el("dl", "exec-metrics");
    metrics.appendChild(metricaExecucao("Início", exec.inicio));
    metrics.appendChild(metricaExecucao("Tempo", exec.tempo));
    metrics.appendChild(metricaExecucao("Tokens", exec.tokens));
    card.appendChild(metrics);

    return card;
  }

  function metricaExecucao(rotulo, valor) {
    const item = el("div", "exec-metric");
    item.appendChild(el("dt", null, rotulo));
    const dd = el("dd", null, valor);
    dd.title = valor;
    item.appendChild(dd);
    return item;
  }

  function rodapeFilaProjeto(projeto, filaProjeto) {
    const rodape = el("div", "col-queue");
    const quantidade = state.query ? filaProjeto.length : projeto.fila;
    rodape.appendChild(
      el(
        "span",
        "col-queue-label",
        `Na fila · ${quantidade}`
      )
    );
    if (filaProjeto.length > 0) {
      const titulo = el("span", "col-queue-title", filaProjeto[0].titulo);
      titulo.title = filaProjeto[0].titulo;
      rodape.appendChild(titulo);
    } else {
      rodape.appendChild(el("span", "col-queue-title", "Nada na fila"));
    }
    return rodape;
  }

  function painelAtencao(itens) {
    const panel = el("section", "panel panel-atencao");
    panel.setAttribute("aria-labelledby", "atencao-title");

    const head = el("div", "panel-head");
    const titulo = el("h2", "panel-title", "Precisa de você");
    titulo.id = "atencao-title";
    head.appendChild(titulo);
    const contador = el("span", "panel-count", itens.length);
    contador.classList.toggle("is-clear", itens.length === 0);
    head.appendChild(contador);
    panel.appendChild(head);

    const lista = el("div", "att-list");
    if (itens.length === 0) {
      lista.appendChild(
        el(
          "p",
          "att-empty",
          state.query
            ? "Nenhum pedido corresponde à busca."
            : "Nada pendente. A mesa está limpa."
        )
      );
    } else {
      itens.forEach((item) => lista.appendChild(itemAtencao(item)));
    }
    panel.appendChild(lista);
    return panel;
  }

  function itemAtencao(item) {
    const projeto = projetoPorId.get(item.projeto);
    const botao = el("button", "att-item");
    botao.type = "button";
    botao.dataset.att = item.id;
    botao.setAttribute(
      "aria-label",
      `${item.tipo}: ${item.pergunta}, projeto ${projeto.nome}, aberto há ${item.idade}`
    );

    const topo = el("div", "att-top");
    topo.appendChild(el("span", "att-type", item.tipo));
    topo.appendChild(el("span", "att-age mono", item.idade));
    botao.appendChild(topo);

    botao.appendChild(el("p", "att-question", item.pergunta));

    const rodape = el("span", "att-project");
    const ponto = el("span", "att-project-dot");
    ponto.style.background = projeto.cor;
    ponto.setAttribute("aria-hidden", "true");
    rodape.appendChild(ponto);
    rodape.appendChild(document.createTextNode(projeto.nome));
    botao.appendChild(rodape);

    return botao;
  }

  function cartaoUpstreamMini() {
    const up = MESA.upstream;
    const panel = el("section", "panel up-mini");
    panel.setAttribute("aria-labelledby", "up-mini-title");

    const head = el("div", "panel-head");
    const titulo = el("h2", "panel-title", "Upstream");
    titulo.id = "up-mini-title";
    head.appendChild(titulo);
    const link = el("a", "panel-link", "Abrir");
    link.href = "#/upstream";
    head.appendChild(link);
    panel.appendChild(head);

    const hero = el("div", "up-hero");
    hero.appendChild(el("span", "up-number", up.atras));
    hero.appendChild(el("span", "up-caption", "commits atrás"));
    panel.appendChild(hero);

    const facts = el("dl", "up-facts");
    facts.appendChild(fatoUp("Último merge", up.ultimoMerge));
    facts.appendChild(fatoUp("Próximo agente", up.agente, true));
    panel.appendChild(facts);

    const gates = el("div", "up-gates-mini");
    gates.appendChild(el("p", "up-gates-label", "Portões"));
    up.portoes.forEach((portao) => {
      const row = el("div", "up-gate-row");
      const caixa = el("span", "up-gate-box");
      caixa.setAttribute("aria-hidden", "true");
      row.appendChild(caixa);
      row.appendChild(el("span", "up-gate-name", portao.nome));
      row.appendChild(el("span", "up-gate-state", portao.estado));
      gates.appendChild(row);
    });
    panel.appendChild(gates);

    const estado = el("div", "up-state");
    estado.appendChild(el("span", null, "Próxima janela"));
    estado.appendChild(el("strong", null, up.proximo));
    panel.appendChild(estado);

    return panel;
  }

  function fatoUp(rotulo, valor, mono) {
    const item = el("div", "up-fact");
    item.appendChild(el("dt", null, rotulo));
    const dd = el("dd", mono ? "mono" : null, valor);
    item.appendChild(dd);
    return item;
  }

  function renderizarProjetos() {
    const termo = state.query;
    const projetos = termo
      ? MESA.projetos.filter((p) => casarProjeto(p, termo))
      : MESA.projetos;

    if (termo) {
      definirContagem(`${projetos.length} ${plural(projetos.length, "resultado", "resultados")}`);
      if (projetos.length === 0) {
        viewEl.replaceChildren(vazioDeBusca());
        return;
      }
    } else {
      const saudaveis = MESA.projetos.filter((p) => p.saude === "ok").length;
      const travados = MESA.projetos.length - saudaveis;
      definirContagem(
        `${MESA.projetos.length} projetos · ${saudaveis} ${plural(
          saudaveis,
          "saudável",
          "saudáveis"
        )}, ${travados} ${plural(travados, "travado", "travados")}`
      );
    }

    const wrapper = el("div", "projetos");
    wrapper.appendChild(resumoProjetos());
    const grade = el("div", "projects-grid");
    projetos.forEach((projeto) => grade.appendChild(cartaoProjeto(projeto)));
    wrapper.appendChild(grade);
    viewEl.replaceChildren(wrapper);

    if (state.realcarProjeto) {
      const id = state.realcarProjeto;
      state.realcarProjeto = null;
      realcarCartaoProjeto(id);
    }
  }

  function resumoProjetos() {
    const saudaveis = MESA.projetos.filter((p) => p.saude === "ok");
    const travados = MESA.projetos.filter((p) => p.saude !== "ok");
    const caixa = el("section", "project-summary");
    caixa.setAttribute("aria-label", "Leitura rápida dos projetos");
    const texto = el("p");

    if (saudaveis.length > 0) {
      texto.appendChild(el("strong", null, listaNomes(saudaveis)));
      texto.appendChild(
        document.createTextNode(
          ` ${plural(saudaveis.length, "está saudável", "estão saudáveis")}. `
        )
      );
    }
    travados.forEach((projeto, indice) => {
      if (indice > 0) texto.appendChild(document.createTextNode(" "));
      texto.appendChild(el("strong", null, projeto.nome));
      texto.appendChild(
        document.createTextNode(
          ` ${plural(1, "está travado", "estão travados")}: ${projeto.saudeMotivo}.`
        )
      );
    });
    if (travados.length === 0) {
      texto.appendChild(document.createTextNode("Nenhum projeto travado."));
    }

    caixa.appendChild(texto);
    return caixa;
  }

  function cartaoProjeto(projeto) {
    const card = el("article", "project-card");
    card.dataset.project = projeto.id;
    card.tabIndex = -1;
    card.style.setProperty("--project", projeto.cor);
    card.setAttribute("aria-labelledby", `projeto-${projeto.id}`);

    const head = el("header", "project-card-head");
    const bloco = el("div");
    const nome = el("h2", "project-card-name");
    nome.id = `projeto-${projeto.id}`;
    const ponto = el("span", "project-dot");
    ponto.style.background = projeto.cor;
    ponto.setAttribute("aria-hidden", "true");
    nome.appendChild(ponto);
    nome.appendChild(document.createTextNode(projeto.nome));
    bloco.appendChild(nome);
    bloco.appendChild(el("p", "project-card-desc", projeto.descricao));
    head.appendChild(bloco);
    head.appendChild(
      el(
        "span",
        `health ${projeto.saude === "ok" ? "health-ok" : "health-atencao"}`,
        projeto.saudeTexto
      )
    );
    card.appendChild(head);

    const branch = el("span", "project-card-branch", projeto.branch);
    branch.title = projeto.branch;
    card.appendChild(branch);

    const ativas = MESA.execucoes.filter(
      (e) => e.projeto === projeto.id && e.estado === "executando"
    );
    const aguardando = MESA.execucoes.filter(
      (e) => e.projeto === projeto.id && e.estado === "aguardando"
    );

    const facts = el("dl", "project-card-facts");
    facts.appendChild(fatoCartao("WIP", projeto.wip));
    facts.appendChild(fatoCartao("Na fila", projeto.fila));
    facts.appendChild(fatoCartao("Ativas", ativas.length));
    facts.appendChild(fatoCartao("Merge", projeto.merge));
    card.appendChild(facts);

    const movimento = el("dl", "project-move");
    movimento.appendChild(el("dt", null, "Último movimento"));
    movimento.appendChild(el("dd", null, projeto.ultimoMovimento));
    card.appendChild(movimento);

    const pedidos = atencaoAtiva().filter((a) => a.projeto === projeto.id);
    if (pedidos.length > 0) {
      const needs = el("div", "project-needs");
      needs.appendChild(el("strong", null, pedidos.length));
      const frase = el(
        "p",
        null,
        `${plural(pedidos.length, "pedido aberto", "pedidos abertos")}: ${pedidos[0].pergunta}`
      );
      if (pedidos.length > 1) {
        frase.textContent += ` e mais ${pedidos.length - 1}.`;
      } else {
        frase.textContent += ".";
      }
      needs.appendChild(frase);
      card.appendChild(needs);
    }

    const foot = el("div", "project-card-foot");
    const atividade = el("p", "project-active");
    if (ativas.length === 0 && aguardando.length > 0) {
      atividade.appendChild(el("strong", null, aguardando.length));
      atividade.appendChild(
        document.createTextNode(
          ` ${plural(aguardando.length, "aguardando", "aguardando")}`
        )
      );
    } else {
      atividade.appendChild(el("strong", null, ativas.length));
      atividade.appendChild(
        document.createTextNode(
          ` ${plural(ativas.length, "execução ativa", "execuções ativas")}`
        )
      );
    }
    foot.appendChild(atividade);

    const botao = el("button", "btn btn-secondary", "Abrir no canvas");
    botao.type = "button";
    botao.dataset.canvas = projeto.id;
    foot.appendChild(botao);
    card.appendChild(foot);

    return card;
  }

  function fatoCartao(rotulo, valor) {
    const item = el("div", "project-card-fact");
    item.appendChild(el("dt", null, rotulo));
    item.appendChild(el("dd", null, valor));
    return item;
  }

  function realcarCartaoProjeto(id) {
    const card = viewEl.querySelector(`.project-card[data-project="${id}"]`);
    if (!card) return;
    card.classList.add("is-pinged");
    card.focus({ preventScroll: false });
    window.setTimeout(() => card.classList.remove("is-pinged"), 1000);
  }

  function renderizarFila() {
    const termo = state.query;
    const ordenada = MESA.fila
      .slice()
      .sort((a, b) => PRIORIDADES[a.prioridade].ordem - PRIORIDADES[b.prioridade].ordem);
    const itens = termo ? ordenada.filter((f) => casarFila(f, termo)) : ordenada;

    if (termo) {
      definirContagem(`${itens.length} ${plural(itens.length, "resultado", "resultados")}`);
      if (itens.length === 0) {
        viewEl.replaceChildren(vazioDeBusca());
        return;
      }
    } else {
      const prontas = ordenada.filter((f) => f.estado === "pronta").length;
      const esperando = ordenada.length - prontas;
      definirContagem(
        `${ordenada.length} itens · ${prontas} ${plural(prontas, "pronto", "prontos")}, ${esperando} esperando`
      );
    }

    const wrapper = el("div", "fila");
    wrapper.appendChild(resumoFila(ordenada));

    const panel = el("section", "queue-panel");
    panel.setAttribute("role", "table");
    panel.setAttribute("aria-label", "Fila de trabalho por prioridade");

    const head = el("div", "queue-head");
    head.setAttribute("role", "row");
    ["Prioridade", "Item", "Agente sugerido", "Dependência", "Ação"].forEach((rotulo) => {
      const cell = el("span", null, rotulo);
      cell.setAttribute("role", "columnheader");
      head.appendChild(cell);
    });
    panel.appendChild(head);

    const body = el("div");
    body.setAttribute("role", "rowgroup");
    if (itens.length === 0) {
      body.appendChild(el("p", "queue-empty", "Nenhum item corresponde à busca."));
    } else {
      itens.forEach((item) => body.appendChild(UI.linhaFila(item)));
    }
    panel.appendChild(body);
    wrapper.appendChild(panel);
    viewEl.replaceChildren(wrapper);
  }

  function resumoFila(ordenada) {
    const grid = el("div", "fila-summary");
    const proximo = ordenada[0];
    const esperando = ordenada.filter((f) => f.dependencia);

    const comecar = el("section", "summary-card");
    comecar.appendChild(el("p", "summary-label", "Começa a seguir"));
    comecar.appendChild(el("h2", "summary-title", proximo.titulo));
    const meta = el("div", "summary-meta");
    const prioridade = PRIORIDADES[proximo.prioridade];
    meta.appendChild(el("span", `priority ${prioridade.classe}`, prioridade.rotulo));
    meta.appendChild(el("span", null, proximo.agente));
    const projeto = projetoPorId.get(proximo.projeto);
    meta.appendChild(el("span", null, projeto.nome));
    comecar.appendChild(meta);
    grid.appendChild(comecar);

    const espera = el("section", "summary-card");
    espera.appendChild(el("p", "summary-label", `Esperando · ${esperando.length}`));
    if (esperando.length === 0) {
      espera.appendChild(el("p", "summary-title", "Nada preso. Todas as tarefas estão prontas."));
    } else {
      const lista = el("div", "summary-waiting");
      esperando.forEach((item) => {
        const linha = el("span");
        linha.appendChild(el("b", null, item.titulo));
        const alvo = execucaoPorId.get(item.dependencia);
        linha.appendChild(
          el("em", null, `espera ${alvo ? alvo.titulo : item.dependencia}`)
        );
        lista.appendChild(linha);
      });
      espera.appendChild(lista);
    }
    grid.appendChild(espera);
    return grid;
  }


  Object.assign(UI, {
    MESA,
    ESTADOS,
    PRIORIDADES,
    ACOES_POR_ESTADO,
    state,
    projetoPorId,
    execucaoPorId,
    viewEl,
    buscaEl,
    tabsEl,
    statsEl,
    questionEl,
    countEl,
    chipEl,
    footEl,
    drawerEl,
    drawerCloseEl,
    drawerTitleEl,
    drawerKickerEl,
    drawerSubEl,
    drawerBodyEl,
    drawerActionsEl,
    scrimEl,
    toastEl,
    el,
    normalizar,
    contem,
    listaNomes,
    plural,
    atencaoAtiva,
    execucoesAtivas,
    minutosDaIdade,
    atencaoMaisAntiga,
    viewAtual,
    casarExecucao,
    casarAtencao,
    casarFila,
    casarProjeto,
    casarUpstream,
    criarPilulaEstado,
    construirChrome,
    criarStat,
    renderizarChrome,
    definirContagem,
    vazioDeBusca,
    renderizarAgora,
    cabecalhoProjeto,
    fatoProjeto,
    cartaoExecucao,
    metricaExecucao,
    rodapeFilaProjeto,
    painelAtencao,
    itemAtencao,
    cartaoUpstreamMini,
    fatoUp,
    renderizarProjetos,
    resumoProjetos,
    cartaoProjeto,
    fatoCartao,
    realcarCartaoProjeto,
    renderizarFila,
    resumoFila,
  });
})();
