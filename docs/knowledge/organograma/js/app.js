(function () {
  const DATA = window.GLIMPSE;
  if (!DATA) {
    document.getElementById('conteudo').innerHTML =
      '<p class="empty">Dados não carregados. Abra data/dados.js antes de js/app.js.</p>';
    return;
  }

  const { meta, views, nodes, relations } = DATA;
  const byId = new Map(nodes.map((no) => [no.id, no]));
  const state = { view: 'geral', selected: null, query: '' };

  const el = (tag, attrs, html) => {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [key, value] of Object.entries(attrs)) {
        if (value === false || value == null) continue;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'html') node.innerHTML = value;
        else if (key.startsWith('data-')) node.setAttribute(key, value);
        else node.setAttribute(key, value);
      }
    }
    if (html != null) node.innerHTML = html;
    return node;
  };

  const fmt = (n) => new Intl.NumberFormat('pt-BR').format(n || 0);
  const statusLabel = {
    base: 'Base',
    fork: 'Glimpse',
    misto: 'Misto',
    morto: 'Poda',
    risco: 'Risco',
  };

  function parseHash() {
    const raw = location.hash.replace(/^#\/?/, '');
    const [viewPart, queryPart] = raw.split('?');
    const view = views.some((v) => v.id === viewPart) ? viewPart : 'geral';
    const params = new URLSearchParams(queryPart || '');
    return { view, sel: params.get('sel') };
  }

  function writeHash(view, sel) {
    const params = new URLSearchParams();
    if (sel) params.set('sel', sel);
    const suffix = params.toString() ? `?${params.toString()}` : '';
    const next = `#/${view}${suffix}`;
    if (location.hash !== next) history.replaceState(null, '', next);
  }

  function renderTabs() {
    const nav = document.getElementById('abas');
    nav.innerHTML = '';
    views.forEach((view, index) => {
      const a = el('a', {
        class: 'tab',
        href: `#/${view.id}`,
        'data-view': view.id,
        'aria-current': state.view === view.id ? 'page' : null,
      });
      a.innerHTML = `<span class="tab-n">${index + 1}</span><span>${view.label}</span>`;
      nav.appendChild(a);
    });
  }

  function renderSummary(view, viewNodes) {
    const counts = {};
    let lines = 0;
    for (const node of viewNodes) {
      counts[node.status] = (counts[node.status] || 0) + 1;
      lines += node.lines || 0;
    }
    const wrap = el('div', { class: 'summary' });
    const order = ['fork', 'misto', 'base', 'morto', 'risco'];
    for (const status of order) {
      if (!counts[status]) continue;
      wrap.appendChild(
        el('span', {
          class: 'summary-item',
          html: `<strong>${counts[status]}</strong> ${statusLabel[status] || status}`,
        })
      );
    }
    wrap.appendChild(
      el('span', {
        class: 'summary-item',
        html: `<strong>${fmt(lines)}</strong> ${view.summaryLabel || 'linhas somadas'}`,
      })
    );
    return wrap;
  }

  function renderCard(node) {
    const card = el('button', {
      class: 'card',
      type: 'button',
      'data-status': node.status,
      'data-node': node.id,
      'aria-label': `${node.name}, ${statusLabel[node.status] || node.status}. Abrir detalhe.`,
    });
    card.innerHTML = `
      <div class="card-top">
        <span class="badge">${statusLabel[node.status] || node.status}</span>
        <span class="card-lines">${fmt(node.lines)} ln</span>
      </div>
      <h3 class="card-name">${node.name}</h3>
      <p class="card-summary">${node.summary}</p>
      <div class="card-meta">
        <span class="chip"><strong>${fmt(node.files)}</strong> arq. no diff</span>
        <span class="chip"><strong>+${fmt(node.added)}</strong> / -${fmt(node.removed)}</span>
      </div>
    `;
    return card;
  }

  function renderView() {
    const view = views.find((v) => v.id === state.view) || views[0];
    const viewNodes = nodes.filter((node) => node.view === view.id);
    const content = document.getElementById('conteudo');
    content.innerHTML = '';

    const head = el('header', { class: 'view-head' });
    head.innerHTML = `
      <p class="kicker">${view.kicker}</p>
      <h1 class="view-title">${view.title}</h1>
      <p class="view-desc">${view.description}</p>
    `;
    content.appendChild(head);
    content.appendChild(renderSummary(view, viewNodes));

    const groups = [];
    for (const node of viewNodes) {
      let group = groups.find((g) => g.name === node.group);
      if (!group) {
        group = { name: node.group, nodes: [] };
        groups.push(group);
      }
      group.nodes.push(node);
    }

    for (const group of groups) {
      const section = el('section', { class: 'group' });
      section.appendChild(el('h2', { class: 'group-title', text: group.name }));
      const grid = el('div', { class: 'grid' });
      for (const node of group.nodes) grid.appendChild(renderCard(node));
      section.appendChild(grid);
      content.appendChild(section);
    }
  }

  function renderRelations(node) {
    const rows = relations.filter((rel) => rel.from === node.id || rel.to === node.id);
    if (!rows.length) return '';
    return rows
      .map((rel) => {
        const otherId = rel.from === node.id ? rel.to : rel.from;
        const other = byId.get(otherId);
        if (!other) return '';
        const direction = rel.from === node.id ? '→' : '←';
        return `<span class="rel">${direction} ${rel.label}: ${other.name}</span>`;
      })
      .join('');
  }

  function renderPanel(node) {
    const panel = document.getElementById('painel');
    const layout = document.getElementById('layout');
    if (!node) {
      panel.hidden = true;
      layout.classList.remove('has-panel');
      document.getElementById('scrim').hidden = true;
      return;
    }
    panel.hidden = false;
    layout.classList.add('has-panel');
    document.getElementById('scrim').hidden = true;
    panel.innerHTML = `
      <div class="panel-head">
        <div>
          <p class="panel-kicker">${node.group} · ${statusLabel[node.status] || node.status}</p>
          <h2 class="panel-title">${node.name}</h2>
        </div>
        <button type="button" class="panel-close" data-close aria-label="Fechar detalhe">×</button>
      </div>
      <p class="panel-summary">${node.summary}</p>
      <p class="panel-detail">${node.detail || ''}</p>
      <div class="panel-grid">
        <div class="panel-stat"><span class="panel-label">Linhas</span><span class="panel-value">${fmt(node.lines)}</span></div>
        <div class="panel-stat"><span class="panel-label">Arquivos no diff</span><span class="panel-value">${fmt(node.files)}</span></div>
        <div class="panel-stat"><span class="panel-label">Adicionadas</span><span class="panel-value">+${fmt(node.added)}</span></div>
        <div class="panel-stat"><span class="panel-label">Removidas</span><span class="panel-value">-${fmt(node.removed)}</span></div>
      </div>
      <div class="panel-section">
        <h3>Fonte</h3>
        <p><code>${node.source}</code></p>
      </div>
      <div class="panel-section">
        <h3>Decisão provisória</h3>
        <p>${node.decision || 'A definir'}</p>
      </div>
      <div class="panel-section">
        <h3>Relações</h3>
        <div class="panel-rel">${renderRelations(node) || '<span class="rel">Sem relações mapeadas</span>'}</div>
      </div>
    `;
    panel.querySelector('[data-close]').addEventListener('click', closePanel);
    if (window.innerWidth <= 980) {
      document.getElementById('scrim').hidden = false;
    }
  }

  function openPanel(id) {
    const node = byId.get(id);
    if (!node) return;
    state.selected = id;
    writeHash(state.view, id);
    renderPanel(node);
    const anuncio = document.getElementById('anuncio');
    anuncio.textContent = `${node.name} selecionado.`;
  }

  function closePanel() {
    state.selected = null;
    writeHash(state.view, null);
    renderPanel(null);
  }

  function renderSearch(query) {
    const list = document.getElementById('busca-lista');
    const input = document.getElementById('busca-entrada');
    const q = query.trim().toLowerCase();
    const results = !q
      ? nodes.slice(0, 12)
      : nodes
          .filter((node) =>
            [node.name, node.summary, node.detail, node.source, node.group, statusLabel[node.status]]
              .join(' ')
              .toLowerCase()
              .includes(q)
          )
          .slice(0, 20);
    list.innerHTML = '';
    if (!results.length) {
      list.innerHTML = '<li class="empty">Nenhum resultado. Tente outro termo.</li>';
      input.setAttribute('aria-expanded', 'false');
      return;
    }
    input.setAttribute('aria-expanded', 'true');
    results.forEach((node, index) => {
      const li = el('li', { role: 'option', 'aria-selected': index === 0 ? 'true' : 'false' });
      const button = el('button', { type: 'button', class: 'search-item', 'data-node': node.id });
      button.innerHTML = `<strong>${node.name}</strong><span>${node.group} · ${statusLabel[node.status]} · ${fmt(node.lines)} linhas</span>`;
      li.appendChild(button);
      list.appendChild(li);
    });
  }

  function openSearch() {
    const dialog = document.getElementById('busca');
    if (!dialog.open) dialog.showModal();
    const input = document.getElementById('busca-entrada');
    input.value = '';
    state.query = '';
    renderSearch('');
    input.focus();
  }

  function closeSearch() {
    const dialog = document.getElementById('busca');
    if (dialog.open) dialog.close();
  }

  function toggleTheme() {
    const root = document.documentElement;
    const current = root.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    try {
      localStorage.setItem('glimpse-organograma-tema', next === 'dark' ? 'escuro' : 'claro');
    } catch (erro) { /* sem armazenamento */ }
    document.getElementById('btn-tema').setAttribute('aria-pressed', String(next === 'dark'));
  }

  function moveFocus(delta) {
    const cards = Array.from(document.querySelectorAll('.card'));
    if (!cards.length) return;
    const current = cards.indexOf(document.activeElement);
    const next = current < 0 ? 0 : (current + delta + cards.length) % cards.length;
    cards[next].focus();
  }

  function init() {
    const initial = parseHash();
    state.view = initial.view;
    state.selected = initial.sel;
    renderTabs();
    renderView();
    if (state.selected) renderPanel(byId.get(state.selected));

    document.getElementById('btn-busca').addEventListener('click', openSearch);
    document.getElementById('btn-tema').addEventListener('click', toggleTheme);
    document.getElementById('btn-imprimir').addEventListener('click', () => window.print());

    document.getElementById('busca-entrada').addEventListener('input', (event) => {
      state.query = event.target.value;
      renderSearch(state.query);
    });

    document.getElementById('busca-entrada').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        const first = document.querySelector('#busca-lista [data-node]');
        if (first) {
          const id = first.getAttribute('data-node');
          closeSearch();
          openPanel(id);
        }
      }
    });

    document.getElementById('scrim').addEventListener('click', closePanel);

    document.addEventListener('click', (event) => {
      const nodeEl = event.target.closest('[data-node]');
      if (nodeEl) {
        const id = nodeEl.getAttribute('data-node');
        if (document.getElementById('busca').open) closeSearch();
        openPanel(id);
        return;
      }
      const tab = event.target.closest('.tab');
      if (tab) {
        event.preventDefault();
        state.view = tab.getAttribute('data-view');
        state.selected = null;
        writeHash(state.view, null);
        renderTabs();
        renderView();
        renderPanel(null);
        document.getElementById('conteudo').focus();
      }
    });

    document.addEventListener('keydown', (event) => {
      const target = event.target;
      const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA');
      if (event.key === '/' && !typing && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        openSearch();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        openSearch();
        return;
      }
      if (event.key === 'Escape') {
        if (document.getElementById('busca').open) closeSearch();
        else if (state.selected) closePanel();
        return;
      }
      if (!typing && (event.key === 'ArrowRight' || event.key === 'ArrowDown')) {
        event.preventDefault();
        moveFocus(1);
      }
      if (!typing && (event.key === 'ArrowLeft' || event.key === 'ArrowUp')) {
        event.preventDefault();
        moveFocus(-1);
      }
      if (!typing && event.key === 'Enter' && document.activeElement?.classList.contains('card')) {
        openPanel(document.activeElement.getAttribute('data-node'));
      }
    });

    window.addEventListener('hashchange', () => {
      const next = parseHash();
      if (next.view !== state.view) {
        state.view = next.view;
        state.selected = next.sel;
        renderTabs();
        renderView();
      }
      if (next.sel !== state.selected) {
        state.selected = next.sel;
        renderPanel(next.sel ? byId.get(next.sel) : null);
      }
    });

    document.getElementById('anuncio').textContent = `${meta.produto} carregado. ${nodes.length} itens em ${views.length} visões.`;
  }

  init();
})();
