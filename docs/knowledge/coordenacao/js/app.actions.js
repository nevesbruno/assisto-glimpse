(function () {
  "use strict";

  const UI = window.MesaCoord;
  if (!UI) {
    return;
  }

  const { ACOES_POR_ESTADO, ESTADOS, MESA, PRIORIDADES, buscaEl, casarUpstream, chipEl, construirChrome, criarPilulaEstado, definirContagem, drawerActionsEl, drawerBodyEl, drawerCloseEl, drawerEl, drawerKickerEl, drawerSubEl, drawerTitleEl, el, execucaoPorId, projetoPorId, questionEl, realcarCartaoProjeto, renderizarAgora, renderizarChrome, renderizarFila, renderizarProjetos, scrimEl, state, toastEl, vazioDeBusca, viewAtual, viewEl } = UI;

  function linhaFila(item) {
    const projeto = projetoPorId.get(item.projeto);
    const prioridade = PRIORIDADES[item.prioridade];
    const row = el("div", "queue-row");
    row.setAttribute("role", "row");
    row.dataset.queue = item.id;

    const celPrioridade = el("div");
    celPrioridade.setAttribute("role", "cell");
    celPrioridade.appendChild(
      el("span", `priority ${prioridade.classe}`, prioridade.rotulo)
    );
    row.appendChild(celPrioridade);

    const celItem = el("div", "queue-main");
    celItem.setAttribute("role", "cell");
    celItem.appendChild(el("p", "queue-title", item.titulo));
    const projetoLinha = el("p", "queue-project");
    const ponto = el("span", "queue-dot");
    ponto.style.background = projeto.cor;
    ponto.setAttribute("aria-hidden", "true");
    projetoLinha.appendChild(ponto);
    projetoLinha.appendChild(document.createTextNode(projeto.nome));
    celItem.appendChild(projetoLinha);
    row.appendChild(celItem);

    const celAgente = el("div", "queue-agent");
    celAgente.setAttribute("role", "cell");
    celAgente.appendChild(document.createTextNode(item.agente));
    celAgente.appendChild(el("span", null, "sugerido"));
    row.appendChild(celAgente);

    const celDep = el("div", "queue-dep");
    celDep.setAttribute("role", "cell");
    if (item.dependencia) {
      const alvo = execucaoPorId.get(item.dependencia);
      celDep.appendChild(el("strong", null, `Depende de ${item.dependencia}`));
      celDep.appendChild(el("span", null, alvo ? alvo.titulo : "Execução em andamento"));
    } else {
      celDep.className = "queue-dep is-free";
      celDep.textContent = "Sem dependência, pronta";
    }
    row.appendChild(celDep);

    const celAcao = el("div", "queue-action");
    celAcao.setAttribute("role", "cell");
    const botao = el("button", "btn btn-secondary", "Despachar");
    botao.type = "button";
    botao.dataset.dispatch = item.id;
    botao.setAttribute(
      "aria-label",
      `Despachar ${item.titulo}, projeto ${projeto.nome}`
    );
    celAcao.appendChild(botao);
    row.appendChild(celAcao);

    return row;
  }

  function renderizarUpstream() {
    const up = MESA.upstream;
    if (state.query && !casarUpstream(state.query)) {
      definirContagem("0 resultados");
      viewEl.replaceChildren(vazioDeBusca());
      return;
    }

    if (state.query) {
      definirContagem("1 resultado");
    } else {
      definirContagem(
        `${up.atras} commits atrás · último resultado: ${up.resultado}`
      );
    }

    const card = el("section", "upstream-card");
    card.setAttribute("aria-labelledby", "upstream-heading");

    const topo = el("div", "up-top");
    const hero = el("div");
    const heroLinha = el("div", "up-hero-big");
    heroLinha.appendChild(el("span", "up-big", up.atras));
    const copia = el("div", "up-big-copy");
    const titulo = el("strong", null, "commits atrás");
    titulo.id = "upstream-heading";
    copia.appendChild(titulo);
    copia.appendChild(el("span", null, "do upstream desde o último merge"));
    heroLinha.appendChild(copia);
    hero.appendChild(heroLinha);
    const janela = el("p", "up-window");
    const ponto = el("span", "window-dot");
    ponto.setAttribute("aria-hidden", "true");
    janela.appendChild(ponto);
    janela.appendChild(document.createTextNode(`Próxima janela: ${up.proximo}`));
    hero.appendChild(janela);
    topo.appendChild(hero);

    const direita = el("div");
    const lead = el("p", "up-lead");
    const partes = up.nota.split(". ");
    if (partes.length > 1) {
      lead.appendChild(el("strong", null, partes[0]));
      lead.appendChild(document.createTextNode(`. ${partes.slice(1).join(". ")}`));
    } else {
      lead.textContent = up.nota;
    }
    direita.appendChild(lead);

    const facts = el("dl", "up-facts-grid");
    facts.appendChild(caixaFatoUp("Último merge", up.ultimoMerge));
    facts.appendChild(caixaFatoUp("Próximo agente", up.agente, true));
    facts.appendChild(caixaFatoUp("Último resultado", up.resultado));
    direita.appendChild(facts);
    topo.appendChild(direita);
    card.appendChild(topo);

    const colunas = el("div", "up-columns");

    const portoes = el("section");
    portoes.setAttribute("aria-labelledby", "portoes-title");
    const tituloPortoes = el("h2", "section-label", "Portões antes do merge");
    tituloPortoes.id = "portoes-title";
    portoes.appendChild(tituloPortoes);
    const listaPortoes = el("div", "gates-list");
    up.portoes.forEach((portao) => {
      const row = el("div", "gate-row");
      const caixa = el("span", "gate-box");
      caixa.setAttribute("aria-hidden", "true");
      row.appendChild(caixa);
      const copiaPortao = el("div", "gate-copy");
      copiaPortao.appendChild(el("p", "gate-name", portao.nome));
      copiaPortao.appendChild(el("p", "gate-detail", portao.detalhe));
      row.appendChild(copiaPortao);
      row.appendChild(el("span", "gate-state", portao.estado));
      listaPortoes.appendChild(row);
    });
    portoes.appendChild(listaPortoes);
    colunas.appendChild(portoes);

    const classes = el("section");
    classes.setAttribute("aria-labelledby", "classes-title");
    const tituloClasses = el("h2", "section-label", "Classes de risco");
    tituloClasses.id = "classes-title";
    classes.appendChild(tituloClasses);
    const listaClasses = el("div", "classes-list");
    up.classes.forEach((classe) => {
      const row = el("div", "class-row");
      row.appendChild(el("span", "class-badge", classe.classe));
      const copiaClasse = el("div", "class-copy");
      copiaClasse.appendChild(el("p", "class-name", classe.nome));
      copiaClasse.appendChild(el("p", "class-text", classe.texto));
      row.appendChild(copiaClasse);
      listaClasses.appendChild(row);
    });
    classes.appendChild(listaClasses);
    colunas.appendChild(classes);

    card.appendChild(colunas);

    const foot = el("footer", "up-foot");
    const copiaFoot = el("p", "up-foot-copy");
    copiaFoot.appendChild(el("strong", null, `Próxima janela: ${up.proximo}.`));
    copiaFoot.appendChild(
      document.createTextNode(` Último resultado: ${up.resultado}.`)
    );
    foot.appendChild(copiaFoot);

    const acoes = el("div", "up-actions");
    acoes.appendChild(el("span", "sim-label", "ação simulada"));
    const botao = el("button", "btn btn-primary", "Rodar merge agora");
    botao.type = "button";
    botao.dataset.merge = "true";
    acoes.appendChild(botao);
    foot.appendChild(acoes);
    card.appendChild(foot);

    viewEl.replaceChildren(card);
  }

  function caixaFatoUp(rotulo, valor, mono) {
    const caixa = el("div", "up-fact-box");
    caixa.appendChild(el("dt", null, rotulo));
    caixa.appendChild(el("dd", mono ? "is-mono" : null, valor));
    return caixa;
  }

  function renderizar() {
    state.view = viewAtual();
    const view = MESA.meta.views.find((v) => v.id === state.view);
    questionEl.textContent = view ? view.pergunta : "";
    renderizarChrome();

    if (state.view === "projetos") {
      renderizarProjetos();
    } else if (state.view === "fila") {
      renderizarFila();
    } else if (state.view === "upstream") {
      renderizarUpstream();
    } else {
      renderizarAgora();
    }
  }

  function cartaoAtual() {
    return state.aberto ? execucaoPorId.get(state.aberto) : null;
  }

  function abrirDrawer(id) {
    const exec = execucaoPorId.get(id);
    if (!exec) return;
    state.ultimoFoco = document.activeElement;
    state.aberto = id;
    preencherDrawer(exec);
    drawerEl.removeAttribute("inert");
    drawerEl.setAttribute("aria-hidden", "false");
    drawerEl.classList.add("is-open");
    scrimEl.classList.add("is-open");
    document.body.classList.add("has-drawer");
    drawerCloseEl.focus();
  }

  function preencherDrawer(exec) {
    const projeto = projetoPorId.get(exec.projeto);
    const info = ESTADOS[exec.estado];

    drawerKickerEl.style.setProperty("--project", projeto.cor);
    drawerKickerEl.replaceChildren();
    const ponto = el("span", "kicker-dot");
    ponto.setAttribute("aria-hidden", "true");
    drawerKickerEl.appendChild(ponto);
    drawerKickerEl.appendChild(document.createTextNode(projeto.nome));
    drawerKickerEl.appendChild(el("span", "kicker-sep", "·"));
    drawerKickerEl.appendChild(document.createTextNode(exec.agente));

    drawerTitleEl.textContent = exec.titulo;

    drawerSubEl.replaceChildren();
    drawerSubEl.appendChild(criarPilulaEstado(exec.estado));
    const provedor = el("span", null, exec.provedor);
    const sep = el("span", "drawer-sub-sep");
    sep.setAttribute("aria-hidden", "true");
    drawerSubEl.append(provedor, sep, el("span", null, `início ${exec.inicio}`));

    drawerBodyEl.className = `drawer-body ${info.classe}`;
    drawerBodyEl.replaceChildren();

    const stats = el("dl", "drawer-stats");
    stats.appendChild(statDrawer("Início", exec.inicio));
    stats.appendChild(statDrawer("Duração", exec.tempo));
    stats.appendChild(statDrawer("Tokens", exec.tokens));
    stats.appendChild(statDrawer("Custo estimado", exec.custo));
    drawerBodyEl.appendChild(stats);

    const secaoFazendo = el("section", "drawer-section");
    secaoFazendo.appendChild(el("h3", null, "O que está acontecendo"));
    secaoFazendo.appendChild(el("p", "drawer-text", exec.fazendo));
    drawerBodyEl.appendChild(secaoFazendo);

    const secaoTimeline = el("section", "drawer-section");
    secaoTimeline.appendChild(el("h3", null, "Linha do tempo"));
    const timeline = el("ol", "timeline");
    exec.timeline.forEach((evento, indice) => {
      const item = el("li", "timeline-item");
      const pendente =
        exec.estado !== "concluido" &&
        (indice === exec.timeline.length - 1 || evento.hora === "agora");
      if (pendente) item.classList.add("is-pending");
      item.appendChild(el("span", "timeline-time", evento.hora));
      item.appendChild(el("span", "timeline-text", evento.texto));
      timeline.appendChild(item);
    });
    secaoTimeline.appendChild(timeline);
    drawerBodyEl.appendChild(secaoTimeline);

    drawerBodyEl.appendChild(
      el(
        "p",
        "drawer-note",
        "Detalhe de exemplo. As ações abaixo mudam apenas o estado em memória deste protótipo."
      )
    );

    drawerActionsEl.replaceChildren();
    const canvas = el("button", "btn btn-ghost btn-canvas", "Abrir no canvas");
    canvas.type = "button";
    canvas.dataset.action = "canvas";
    canvas.dataset.exec = exec.id;
    drawerActionsEl.appendChild(canvas);

    (ACOES_POR_ESTADO[exec.estado] || []).forEach((acao) => {
      const botao = el(
        "button",
        `btn ${acao.tipo === "primary" ? "btn-primary" : "btn-secondary"}`,
        acao.rotulo
      );
      botao.type = "button";
      botao.dataset.action = acao.id;
      botao.dataset.exec = exec.id;
      drawerActionsEl.appendChild(botao);
    });
  }

  function statDrawer(rotulo, valor) {
    const item = el("div", "drawer-stat");
    item.appendChild(el("dt", null, rotulo));
    item.appendChild(el("dd", null, valor));
    return item;
  }

  function fecharDrawer() {
    if (!state.aberto) return;
    state.aberto = null;
    drawerEl.classList.remove("is-open");
    drawerEl.setAttribute("aria-hidden", "true");
    drawerEl.setAttribute("inert", "");
    scrimEl.classList.remove("is-open");
    document.body.classList.remove("has-drawer");

    const foco = state.ultimoFoco;
    state.ultimoFoco = null;
    if (foco && foco.isConnected) {
      foco.focus();
    } else {
      viewEl.focus();
    }
  }

  function resolverAtencaoDaExecucao(id) {
    MESA.atencao.forEach((item) => {
      if (item.alvo.tipo === "execucao" && item.alvo.id === id) {
        state.resolvidos.add(item.id);
      }
    });
  }

  function aplicarAcao(acao, id) {
    const exec = execucaoPorId.get(id);
    if (!exec) return;

    if (acao === "canvas") {
      mostrarAviso(
        `O canvas abriria a execução ${id} no app. Este protótipo não navega para fora da mesa.`
      );
      return;
    }

    if (acao === "pause") {
      exec.estado = "aguardando";
      exec.evento = "Pausada por você";
      exec.fazendo = "Pausada na mesa. O contexto foi preservado e a execução retoma quando você pedir.";
      exec.timeline.push({ hora: "agora", texto: "Pausada por você na mesa" });
      mostrarAviso("Execução pausada. O contexto foi preservado.");
    } else if (acao === "approve") {
      if (exec.estado === "revisao") {
        exec.estado = "concluido";
        exec.evento = "Revisão aprovada";
        exec.fazendo = "Revisão aprovada na mesa. A execução foi concluída.";
        exec.timeline.push({ hora: "agora", texto: "Revisão aprovada na mesa" });
        mostrarAviso("Revisão aprovada. A execução foi concluída.");
      } else {
        exec.estado = "executando";
        exec.evento = "Aprovação registrada, execução retomada";
        exec.fazendo = "Aprovação registrada na mesa. A execução foi retomada e segue o plano.";
        exec.timeline.push({ hora: "agora", texto: "Aprovação registrada na mesa" });
        mostrarAviso("Pedido aprovado. A execução foi retomada.");
      }
      resolverAtencaoDaExecucao(id);
    } else if (acao === "rerun") {
      exec.estado = "executando";
      exec.evento = "Reexecução iniciada agora";
      exec.fazendo = "Reexecução iniciada a partir da mesa. Os primeiros eventos devem chegar em instantes.";
      exec.timeline.push({ hora: "agora", texto: "Reexecução pedida na mesa" });
      mostrarAviso("Execução reiniciada no protótipo.");
    } else if (acao === "dispatch") {
      exec.estado = "executando";
      exec.evento = "Despachada agora";
      exec.fazendo = "Despachada a partir da mesa. Os primeiros eventos devem chegar em instantes.";
      exec.timeline.push({ hora: "agora", texto: "Despachada na mesa" });
      mostrarAviso("Execução despachada no protótipo.");
    } else {
      return;
    }

    renderizar();
    preencherDrawer(exec);
    drawerTitleEl.focus();
  }

  function mostrarAviso(texto) {
    window.clearTimeout(state.toastTimer);
    toastEl.textContent = texto;
    toastEl.classList.add("is-open");
    state.toastTimer = window.setTimeout(() => {
      toastEl.classList.remove("is-open");
    }, 2800);
  }

  function focarAtencao() {
    if (state.query) {
      state.query = "";
      buscaEl.value = "";
      renderizar();
    }
    if (state.view !== "agora") {
      state.pedirAtencao = true;
      window.location.hash = "#/agora";
      return;
    }
    const panel = viewEl.querySelector(".panel-atencao");
    if (!panel) return;
    panel.classList.remove("is-pinged");
    // Reinicia a animação sem depender de tempo.
    void panel.offsetWidth;
    panel.classList.add("is-pinged");
    window.setTimeout(() => panel.classList.remove("is-pinged"), 950);
    const primeiro = panel.querySelector(".att-item");
    if (primeiro) {
      primeiro.focus();
    } else {
      mostrarAviso("Nada pendente. A mesa está limpa.");
    }
  }

  function limparBusca() {
    state.query = "";
    buscaEl.value = "";
    renderizar();
    buscaEl.focus();
  }

  function abrirAtencao(id) {
    const item = MESA.atencao.find((a) => a.id === id);
    if (!item) return;
    if (state.resolvidos.has(item.id)) return;
    if (item.alvo.tipo === "execucao") {
      abrirDrawer(item.alvo.id);
      return;
    }
    if (item.alvo.tipo === "projeto") {
      state.realcarProjeto = item.alvo.id;
      if (state.view === "projetos") {
        realcarCartaoProjeto(item.alvo.id);
        state.realcarProjeto = null;
      } else {
        window.location.hash = "#/projetos";
      }
      mostrarAviso("Decisão aberta no cartão do projeto.");
    }
  }

  function despachar(id) {
    const item = MESA.fila.find((f) => f.id === id);
    if (!item) return;
    if (item.dependencia) {
      const alvo = execucaoPorId.get(item.dependencia);
      mostrarAviso(
        `Despacho bloqueado: ${item.titulo} ainda espera ${item.dependencia}${
          alvo ? `, ${alvo.titulo}` : ""
        }.`
      );
      return;
    }
    mostrarAviso(
      `Despacho simulado: ${item.titulo} entraria na fila de ${item.agente}. Nada foi executado.`
    );
  }

  function eventosDeView() {
    viewEl.addEventListener("click", (evento) => {
      const alvo = evento.target;

      const limpar = alvo.closest("[data-clear]");
      if (limpar) {
        limparBusca();
        return;
      }

      const atencao = alvo.closest("[data-att]");
      if (atencao) {
        abrirAtencao(atencao.dataset.att);
        return;
      }

      const card = alvo.closest("[data-exec]");
      if (card && card.classList.contains("exec-card")) {
        abrirDrawer(card.dataset.exec);
        return;
      }

      const canvas = alvo.closest("[data-canvas]");
      if (canvas) {
        const projeto = projetoPorId.get(canvas.dataset.canvas);
        mostrarAviso(
          `O canvas abriria o projeto ${projeto ? projeto.nome : ""} no app. Este protótipo não navega para fora da mesa.`
        );
        return;
      }

      const dispatch = alvo.closest("[data-dispatch]");
      if (dispatch) {
        despachar(dispatch.dataset.dispatch);
        return;
      }

      const merge = alvo.closest("[data-merge]");
      if (merge) {
        mostrarAviso(
          "Merge não disparado. Este protótipo não executa agentes nem altera o repositório."
        );
      }
    });

    viewEl.addEventListener("keydown", (evento) => {
      const card = evento.target.closest(".exec-card");
      if (!card) return;
      if (evento.key === "Enter" || evento.key === " ") {
        evento.preventDefault();
        abrirDrawer(card.dataset.exec);
      }
    });

    chipEl.addEventListener("click", focarAtencao);
  }

  function eventosGlobais() {
    window.addEventListener("hashchange", () => {
      state.view = viewAtual();
      renderizar();
    });

    buscaEl.addEventListener("input", () => {
      state.query = buscaEl.value.trim();
      renderizar();
    });

    drawerCloseEl.addEventListener("click", fecharDrawer);
    scrimEl.addEventListener("click", fecharDrawer);

    drawerActionsEl.addEventListener("click", (evento) => {
      const botao = evento.target.closest("[data-action]");
      if (!botao) return;
      aplicarAcao(botao.dataset.action, botao.dataset.exec);
    });

    drawerEl.addEventListener("keydown", (evento) => {
      if (evento.key !== "Tab") return;
      const focaveis = Array.from(
        drawerEl.querySelectorAll(
          'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      ).filter((no) => no.offsetParent !== null);
      if (focaveis.length === 0) return;
      const primeiro = focaveis[0];
      const ultimo = focaveis[focaveis.length - 1];
      if (evento.shiftKey && document.activeElement === primeiro) {
        evento.preventDefault();
        ultimo.focus();
      } else if (!evento.shiftKey && document.activeElement === ultimo) {
        evento.preventDefault();
        primeiro.focus();
      }
    });

    document.addEventListener("keydown", (evento) => {
      const digitando =
        evento.target instanceof HTMLElement &&
        (evento.target.matches("input, textarea, select") || evento.target.isContentEditable);

      if (evento.key === "Escape") {
        if (state.aberto) {
          evento.preventDefault();
          fecharDrawer();
          return;
        }
        if (document.activeElement === buscaEl || state.query) {
          evento.preventDefault();
          limparBusca();
        }
        return;
      }

      if (evento.key === "/" && !digitando && !state.aberto && !evento.metaKey && !evento.ctrlKey && !evento.altKey) {
        evento.preventDefault();
        buscaEl.focus();
        buscaEl.select();
      }
    });
  }


  Object.assign(UI, {
    linhaFila,
    renderizarUpstream,
    caixaFatoUp,
    renderizar,
    focarAtencao,
    limparBusca,
  });

  construirChrome();
  eventosDeView();
  eventosGlobais();
  state.view = viewAtual();
  renderizar();
})();
