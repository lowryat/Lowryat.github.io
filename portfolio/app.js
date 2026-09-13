/* Portfolio dashboard renderer. Reads ../reports/portfolio/latest.json, recomputes
   insights with PortfolioAnalytics when settings change, renders everything
   with DOM APIs (textContent only — labels are untrusted data). */
(function () {
  'use strict';
  const A = window.PortfolioAnalytics;
  const $ = (sel, root) => (root || document).querySelector(sel);
  const SERIES = ['--s1', '--s2', '--s3', '--s4', '--s5', '--s6', '--s7', '--s8'];
  const SETTINGS_KEY = 'portfolio.settings.v1';
  const THEME_KEY = 'portfolio.theme';
  const RANGE_KEY = 'portfolio.range';

  const state = { snapshot: null, analytics: null, settings: null, tab: 'overview', range: localStorage.getItem(RANGE_KEY) || '1Y', open: new Set() };

  // ---------- formatting ----------
  const fmt = {
    usd: (x, d = 0) => (x == null || isNaN(x)) ? '—' : (x < 0 ? '−' : '') + '$' + Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }),
    usdSigned: (x, d = 0) => (x == null || isNaN(x)) ? '—' : (x >= 0 ? '+' : '−') + '$' + Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }),
    pct: (x, d = 1) => (x == null || isNaN(x)) ? '—' : (x * 100).toFixed(d) + '%',
    pctSigned: (x, d = 1) => (x == null || isNaN(x)) ? '—' : (x >= 0 ? '+' : '−') + Math.abs(x * 100).toFixed(d) + '%',
    num: (x, d) => (x == null || isNaN(x)) ? '—' : Number(x).toLocaleString('en-US', { maximumFractionDigits: d == null ? (Math.abs(x) >= 100 ? 2 : 4) : d }),
    price: (x) => (x == null || isNaN(x)) ? '—' : '$' + Number(x).toLocaleString('en-US', { minimumFractionDigits: x < 1 ? 4 : 2, maximumFractionDigits: x < 1 ? 4 : 2 }),
    date: (s) => { if (!s) return '—'; const d = new Date(String(s).slice(0, 10) + 'T00:00:00'); return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); },
    dateShort: (s) => { const d = new Date(String(s).slice(0, 10) + 'T00:00:00'); return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); },
  };

  // ---------- DOM helpers ----------
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'style') node.style.cssText = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else if (k === 'text') node.textContent = v;
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c != null && c !== false) node.append(c.nodeType ? c : document.createTextNode(String(c)));
    return node;
  }
  const svgNS = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs, ...children) {
    const n = document.createElementNS(svgNS, tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
    for (const c of children.flat()) if (c != null) n.append(c.nodeType ? c : document.createTextNode(String(c)));
    return n;
  }
  const icon = {
    gear: () => svgEl('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
      svgEl('circle', { cx: 12, cy: 12, r: 3 }), svgEl('path', { d: 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z' })),
    moon: () => svgEl('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, svgEl('path', { d: 'M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z' })),
    sun: () => svgEl('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round' }, svgEl('circle', { cx: 12, cy: 12, r: 4 }), svgEl('path', { d: 'M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41' })),
    chev: () => svgEl('svg', { class: 'chev', viewBox: '0 0 8 13', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, svgEl('path', { d: 'M1.5 1.5 6.5 6.5l-5 5' })),
    warn: () => svgEl('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, svgEl('path', { d: 'M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z' }), svgEl('path', { d: 'M12 9v4M12 17h.01' })),
    info: () => svgEl('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round' }, svgEl('circle', { cx: 12, cy: 12, r: 10 }), svgEl('path', { d: 'M12 16v-4M12 8h.01' })),
    kind: (k) => {
      const paths = {
        harvest: 'M12 2v20M5 9l7 7 7-7', profit_take: 'M3 17l6-6 4 4 8-8M14 7h7v7', hold: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM12 6v6l4 2',
        risk: 'M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4M12 17h.01', basis: 'M4 4h16v16H4zM4 12h16M12 4v16', info: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM12 16v-4M12 8h.01',
      };
      return svgEl('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, svgEl('path', { d: paths[k] || paths.info }));
    },
  };

  const symColor = (() => { const map = {}; let i = 0; return (sym) => { if (!(sym in map)) map[sym] = `var(${SERIES[Math.min(i++, SERIES.length - 1)]})`; return map[sym]; }; })();
  const gainClass = (x) => x > 0 ? 'up' : x < 0 ? 'down' : 'flat';

  // ---------- theme ----------
  function applyTheme(t) { if (t) document.documentElement.setAttribute('data-theme', t); else document.documentElement.removeAttribute('data-theme'); const b = $('#themeBtn'); if (b) { b.replaceChildren(isDark() ? icon.sun() : icon.moon()); b.setAttribute('aria-label', isDark() ? 'Switch to light appearance' : 'Switch to dark appearance'); } }
  function isDark() { const t = document.documentElement.getAttribute('data-theme'); return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches; }

  // ---------- data ----------
  async function load() {
    const status = $('#status');
    try {
      const url = new URL('../reports/portfolio/latest.json', location.href);
      const res = await fetch(url.toString(), { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      state.snapshot = await res.json();
    } catch (e) {
      if (window.PORTFOLIO_FALLBACK) state.snapshot = window.PORTFOLIO_FALLBACK;
      else { status.replaceChildren(banner('err', 'Could not load reports/portfolio/latest.json', `${e.message}. Run "python -m portfolio_analytics snapshot --demo" and serve the repo root (e.g. python -m http.server) — a file:// URL cannot fetch JSON.`)); return; }
    }
    const saved = safeJSON(localStorage.getItem(SETTINGS_KEY));
    state.settings = { ...A.DEFAULTS, ...(state.snapshot.analytics.settings || {}), ...(saved || {}) };
    recompute();
    renderAll();
  }
  const safeJSON = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
  function recompute() { state.analytics = A.buildInsights(state.snapshot, state.settings); }

  // ---------- render ----------
  function renderAll() { renderHeader(); renderStatus(); renderTab(); }

  function renderHeader() {
    const s = state.snapshot, a = state.analytics;
    $('#asOf').textContent = `As of ${fmt.date(s.as_of)} · ${a.lots.length} lots across ${s.positions.length} assets`;
    const src = $('#sourcePills'); src.replaceChildren();
    for (const [name, st] of Object.entries(s.sources || {})) {
      const mode = st.mode || 'unavailable';
      const cls = mode === 'live' ? 'live' : mode === 'demo' ? 'demo' : 'warn';
      src.append(el('span', { class: `pill ${cls}`, title: st.detail || '' }, el('i', { class: 'dot' }), `${name} · ${mode}`));
    }
  }

  function banner(kind, title, body) {
    return el('div', { class: `banner ${kind}` }, kind === 'info' ? icon.info() : icon.warn(), el('div', null, el('b', { text: title }), ' ', body));
  }

  function renderStatus() {
    const s = state.snapshot, box = $('#status'); box.replaceChildren();
    if (s.demo) box.append(banner('', 'Demo data.', 'No Awaken or Robinhood credentials were configured when this snapshot ran. Follow portfolio/SETUP.md to connect your accounts; the layout and math are identical on live data.'));
    const dirty = (s.sources.awaken || {}).dirty;
    if (dirty) box.append(banner('info', 'Awaken ledger is recalculating.', `${dirty} transactions are dirty; gains may be stale until the recalculate finishes.`));
    const bad = (s.robinhood.reconciliation || []).filter(r => !r.ok);
    if (bad.length) box.append(banner('', 'Robinhood quantities don’t match the tax ledger.', bad.map(r => `${r.symbol}: Robinhood ${fmt.num(r.robinhood_qty)} vs ledger ${fmt.num(r.ledger_qty)}`).join(' · ') + '. Usually a trade Awaken hasn’t imported yet — sync the Robinhood account in Awaken.'));
    if (s.positions.some(p => (p.lots || []).some(l => l.age_unknown))) box.append(banner('info', 'Some lots have unknown purchase dates.', 'Awaken returned a balance without lot detail for them; they are treated as long-term for the estimate. Their basis is still correct.'));
  }

  function renderTab() {
    const main = $('#main'); main.replaceChildren();
    document.querySelectorAll('#tabs button').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === state.tab));
    ({ overview: renderOverview, tax: renderTax, signals: renderSignals, holdings: renderHoldings })[state.tab](main);
    $('#footer').replaceChildren(
      el('div', null, `Generated ${new Date(state.snapshot.generated_at).toLocaleString()} · cost-basis method ${state.analytics.basis_method} · rates: short ${fmt.pct(state.settings.short_term_rate + state.settings.state_rate + state.settings.niit_rate, 1)}, long ${fmt.pct(state.settings.long_term_rate + state.settings.state_rate + state.settings.niit_rate, 1)}`),
      el('div', { style: 'margin-top:6px' }, 'Read-only monitoring. Nothing here places trades. Tax figures are estimates using simplified netting; confirm with your CPA before acting. Not investment or tax advice.'),
    );
  }

  // ---------- Overview ----------
  function renderOverview(root) {
    const a = state.analytics, s = state.snapshot, t = a.totals, hs = a.harvest_summary, r = a.risk;
    root.append(el('div', { class: 'grid kpi' },
      kpi('Portfolio value', fmt.usd(t.value), r.return_30d != null ? [fmt.pctSigned(r.return_30d), '30 days'] : null, r.return_30d),
      kpi('Unrealized gain', fmt.usdSigned(t.unrealized), [fmt.pctSigned(t.cost_basis ? t.unrealized / t.cost_basis : 0), 'vs. basis'], t.unrealized),
      kpi('Harvestable losses', fmt.usd(hs.total_loss), [`${hs.candidates} lot${hs.candidates === 1 ? '' : 's'}`, ''], null),
      kpi('Est. tax savings', fmt.usd(hs.est_tax_savings), ['if harvested this year', ''], null),
    ));
    const valueCard = el('div', { class: 'card' });
    const rangeCtl = el('div', { class: 'segmented small', role: 'tablist' });
    for (const rk of ['1M', '3M', '1Y', 'All']) rangeCtl.append(el('button', { role: 'tab', 'aria-selected': state.range === rk, onclick: () => { state.range = rk; localStorage.setItem(RANGE_KEY, rk); renderTab(); } }, rk));
    valueCard.append(el('div', { class: 'card-h' }, el('div', null, el('h3', { class: 'title-3', text: 'Portfolio value' }), el('div', { class: 'footnote secondary', text: s.sources.awaken.mode === 'live' ? 'From Awaken · daily' : 'Demo series' })), rangeCtl));
    valueCard.append(lineChart(s.history, state.range));
    const allocCard = el('div', { class: 'card' }, el('div', { class: 'card-h' }, el('h3', { class: 'title-3', text: 'Allocation' }), el('span', { class: 'footnote secondary', text: `${(r.effective_assets || 0).toFixed(1)} effective assets` })));
    allocCard.append(allocation(s.positions, t.value));
    root.append(el('div', { class: 'grid two' }, valueCard, allocCard));

    const today = el('div', { class: 'list' });
    if (!a.items.length) today.append(el('div', { class: 'empty', text: 'Nothing to act on today.' }));
    for (const it of a.items.slice(0, 6)) today.append(insightRow(it));
    root.append(el('div', { class: 'list-header', text: 'Today' }), today,
      el('div', { class: 'list-footer', text: 'Ranked by priority, then by estimated tax effect. Full lists are on the Tax and Signals tabs.' }));

    const riskCard = el('div', { class: 'card' }, el('div', { class: 'card-h' }, el('h3', { class: 'title-3', text: 'Risk & performance' }), el('span', { class: 'footnote secondary', text: `${r.days || 0} days of history` })));
    riskCard.append(el('div', { class: 'stat-mini' },
      stat('Annualized return', fmt.pctSigned(r.annualized_return)), stat('Volatility (ann.)', fmt.pct(r.annualized_volatility)),
      stat('Sharpe', r.sharpe != null ? r.sharpe.toFixed(2) : '—'), stat('Sortino', r.sortino != null ? r.sortino.toFixed(2) : '—'),
      stat('Max drawdown', fmt.pct(r.max_drawdown)), stat('Current drawdown', fmt.pct(r.current_drawdown)),
      stat('Best / worst day', r.best_day != null ? `${fmt.pctSigned(r.best_day)} / ${fmt.pctSigned(r.worst_day)}` : '—'), stat('Top weight (HHI)', r.top_weight != null ? `${fmt.pct(r.top_weight, 0)} (${r.hhi.toFixed(2)})` : '—')));
    const glCard = el('div', { class: 'card' }, el('div', { class: 'card-h' }, el('h3', { class: 'title-3', text: 'Unrealized gain / loss by asset' }), el('span', { class: 'footnote secondary', text: 'green ▲ gain · red ▼ loss' })));
    glCard.append(gainLossBars(s.positions, a.lots));
    root.append(el('div', { class: 'grid equal', style: 'margin-top:14px' }, riskCard, glCard));
  }

  function kpi(label, value, delta, sign) {
    const d = delta ? el('div', { class: `delta ${sign == null ? 'flat no-arrow' : gainClass(sign)}` }, delta[0], delta[1] ? el('span', { class: 'secondary', style: 'font-weight:500' }, ' ' + delta[1]) : null) : null;
    return el('div', { class: 'card kpi' }, el('div', { class: 'label', text: label }), el('div', { class: 'value num', text: value }), d);
  }
  const stat = (k, v) => el('div', null, el('div', { class: 'k', text: k }), el('div', { class: 'v num', text: v }));

  function insightRow(it) {
    const amt = it.tax_effect != null ? el('div', { class: `amt num ${gainClass(it.tax_effect)} no-arrow` }, fmt.usdSigned(it.tax_effect), el('small', { text: 'est. tax effect' }))
      : it.amount_usd != null ? el('div', { class: 'amt num' }, fmt.usd(it.amount_usd)) : null;
    return el('div', { class: 'insight' }, el('span', { class: `icon-round kind-${it.kind}` }, icon.kind(it.kind)),
      el('div', { style: 'flex:1;min-width:0' }, el('div', { class: 't', text: it.title }), el('div', { class: 'd', text: it.detail })), amt);
  }

  // ---------- Tax ----------
  function renderTax(root) {
    const a = state.analytics, s = state.snapshot, hs = a.harvest_summary, rz = s.realized || {};
    root.append(el('div', { class: 'grid kpi' },
      kpi(`Realized ${rz.year || ''} short-term`, fmt.usdSigned(hs.realized_short_term), null, hs.realized_short_term),
      kpi(`Realized ${rz.year || ''} long-term`, fmt.usdSigned(hs.realized_long_term), null, hs.realized_long_term),
      kpi('Unrealized short-term', fmt.usdSigned(a.totals.unrealized_short), null, a.totals.unrealized_short),
      kpi('Unrealized long-term', fmt.usdSigned(a.totals.unrealized_long), null, a.totals.unrealized_long)));

    const plan = el('div', { class: 'card' }, el('div', { class: 'card-h' }, el('h3', { class: 'title-3', text: 'Year-end plan' }), el('span', { class: 'footnote secondary', text: 'estimated federal + state + NIIT' })));
    const mx = Math.max(hs.est_tax_before, hs.est_tax_after, 1);
    plan.append(el('div', { class: 'ba' }, el('span', { class: 'secondary', text: 'Tax now' }), el('div', { class: 'track' }, el('i', { style: `width:${100 * hs.est_tax_before / mx}%` })), el('span', { class: 'val num', text: fmt.usd(hs.est_tax_before) })));
    plan.append(el('div', { class: 'ba' }, el('span', { class: 'secondary', text: 'After harvest' }), el('div', { class: 'track' }, el('i', { class: 'after', style: `width:${100 * hs.est_tax_after / mx}%` })), el('span', { class: 'val num', text: fmt.usd(hs.est_tax_after) })));
    plan.append(el('div', { class: 'legend' }, el('span', { class: 'li' }, el('i', { class: 'sw', style: 'background:var(--s1)' }), 'realized gains taxed as-is'), el('span', { class: 'li' }, el('i', { class: 'sw', style: 'background:var(--s3)' }), 'after harvesting every candidate below')));
    plan.append(el('div', { class: 'stat-mini', style: 'margin-top:14px' },
      stat('Harvestable loss', fmt.usd(hs.total_loss)), stat('Est. savings', fmt.usd(hs.est_tax_savings)),
      stat('Net gain after', fmt.usdSigned(hs.net_total_after)), stat('Ordinary-income offset', fmt.usd(hs.ordinary_income_offset)),
      stat('Loss carryforward', fmt.usd(hs.carryforward)), stat('Income (staking etc.)', fmt.usd(rz.income || 0))));
    root.append(el('div', { style: 'margin-top:14px' }, plan));

    const list = el('div', { class: 'list' });
    if (!a.harvest.length) list.append(el('div', { class: 'empty', text: 'No lots are at a loss above your thresholds.' }));
    for (const c of a.harvest) list.append(el('div', { class: 'row' }, avatar(c.symbol),
      el('div', { class: 'main' }, el('div', { class: 't' }, `${c.symbol} · ${fmt.num(c.amount)} units`), el('div', { class: 's' }, `Bought ${fmt.date(c.purchased_at)} · basis ${fmt.usd(c.basis)} · ${c.account || 'unknown account'}`)),
      el('span', { class: `pill ${c.term}`, text: c.term === 'long' ? 'Long-term' : 'Short-term' }),
      el('div', { class: 'trail' }, el('div', { class: 't num down', text: fmt.usdSigned(-c.loss) }), el('div', { class: 's num up no-arrow', text: `saves ~${fmt.usd(c.est_tax_savings)}` }))));
    root.append(el('div', { class: 'list-header', text: `Harvest candidates (${a.harvest.length})` }), list,
      el('div', { class: 'list-footer', text: state.settings.wash_sale_conservative ? 'Conservative mode: wait 31 days before re-buying a harvested asset.' : 'Crypto is not currently covered by the wash-sale rule (IRC §1091), so you may re-buy immediately to keep exposure. Toggle conservative mode in Settings if you prefer to wait 31 days.' }));

    const ladder = el('div', { class: 'list' });
    const soon = a.lots.filter(l => l.term === 'short' && !l.age_unknown).sort((x, y) => x.days_to_long_term - y.days_to_long_term);
    if (!soon.length) ladder.append(el('div', { class: 'empty', text: 'Every lot is already long-term.' }));
    for (const l of soon) {
      const progress = 1 - l.days_to_long_term / (state.settings.long_term_days + 1);
      const saved = l.gain > 0 ? l.gain * ((state.settings.short_term_rate) - (state.settings.long_term_rate)) : 0;
      ladder.append(el('div', { class: 'row' }, avatar(l.symbol),
        el('div', { class: 'main' }, el('div', { class: 't' }, `${l.symbol} · long-term on ${fmt.date(l.long_term_on)}`),
          el('div', { class: 'progress', style: 'margin:6px 0 4px' }, el('i', { style: `width:${Math.max(2, progress * 100)}%` })),
          el('div', { class: 's' }, `${l.days_to_long_term} days left · ${fmt.num(l.amount)} units · ${fmt.usdSigned(l.gain)} unrealized`)),
        el('div', { class: 'trail' }, el('div', { class: `t num ${gainClass(l.gain)}`, text: fmt.usdSigned(l.gain) }), el('div', { class: 's secondary num', text: saved > 0 ? `wait saves ~${fmt.usd(saved)}` : 'loss: sell anytime' }))));
    }
    root.append(el('div', { class: 'list-header', text: 'Long-term ladder' }), ladder,
      el('div', { class: 'list-footer', text: 'Short-term lots and the date each one crosses one year. Selling a winner after that date swaps the ordinary rate for the long-term rate.' }));

    if ((s.awaken_harvestable || []).length) {
      const aw = el('div', { class: 'list' });
      for (const r of s.awaken_harvestable) aw.append(el('div', { class: 'row' }, avatar(r.symbol), el('div', { class: 'main' }, el('div', { class: 't', text: `${r.symbol} · ${r.account || r.provider || ''}` }), el('div', { class: 's', text: `balance ${fmt.num(r.balance)} · basis ${fmt.usd(r.cost_basis)} · value ${fmt.usd(r.value)}` })), el('div', { class: 'trail' }, el('div', { class: 't num down', text: fmt.usdSigned(-Math.abs(r.loss)) }))));
      root.append(el('div', { class: 'list-header', text: 'Awaken harvestable losses (per account)' }), aw);
    }
    if (a.missing_basis_count) root.append(el('div', { style: 'margin-top:14px' }, banner('', `${a.missing_basis_count} transactions missing cost basis.`, 'Awaken treats these as $0 cost, which overstates gains. Fix in Awaken before relying on the numbers above.')));
  }

  // ---------- Signals ----------
  function renderSignals(root) {
    const a = state.analytics, s = state.snapshot;
    if (!a.profit_take.length) root.append(el('div', { class: 'card empty', text: 'No profit-taking or rebalancing signals right now.' }));
    for (const t of a.profit_take) {
      const card = el('div', { class: 'card signal-card' });
      const left = el('div', null);
      left.append(el('div', { class: 'card-h', style: 'margin-bottom:4px' }, el('div', { style: 'display:flex;align-items:center;gap:10px' }, avatar(t.symbol), el('div', null, el('h3', { class: 'title-3', text: `Trim ${t.symbol} by ${fmt.usd(t.trim_value)}` }), el('div', { class: 'footnote secondary', text: `${fmt.num(t.trim_units)} units · ${fmt.pct(t.weight, 0)} of portfolio · ${fmt.pctSigned(t.gain_pct, 0)} vs. basis` })))));
      left.append(el('div', { class: 'chip-row' }, ...t.reasons.map(r => el('span', { class: 'pill reason', text: r.replace('_', ' ') }))));
      if (t.sale) left.append(el('div', { class: 'stat-mini', style: 'margin-top:12px' }, stat('Proceeds', fmt.usd(t.sale.proceeds)), stat(`Realized gain (${t.sale.method})`, fmt.usdSigned(t.sale.realized_gain)), stat('Est. tax on sale', fmt.usd(t.sale.est_tax)), stat('Keeps after tax', fmt.usd(t.sale.proceeds - t.sale.est_tax))));
      if (t.wait_for_long_term) { const w = t.wait_for_long_term; left.append(el('div', { class: 'banner info', style: 'margin:12px 0 0' }, icon.info(), el('div', null, el('b', { text: `Consider waiting ${w.max_days} days. ` }), `${w.lots} short-term lot${w.lots === 1 ? '' : 's'} with ${fmt.usd(w.gain_at_stake)} of gain go long-term, saving about ${fmt.usd(w.est_tax_saved_by_waiting)}.`))); }
      const sig = t.signals || {};
      if (sig.available) left.append(el('div', { class: 'muted-note', text: `Price ${fmt.pct(sig.drawdown_from_90d_high, 0)} below 90-day high · ${sig.above_sma50 == null ? '' : sig.above_sma50 ? 'above' : 'below'} 50-day average${sig.return_30d != null ? ` · ${fmt.pctSigned(sig.return_30d, 0)} in 30 days` : ''}` }));
      card.append(left, sparkline(s.price_history[t.symbol], t.symbol, sig));
      root.append(card);
    }

    // Everything else in the insight feed that isn't a trim (harvest/hold/risk/basis)
    const rest = a.items.filter(i => i.kind !== 'profit_take');
    if (rest.length) { const list = el('div', { class: 'list' }); rest.forEach(i => list.append(insightRow(i))); root.append(el('div', { class: 'list-header', text: 'All insights' }), list); }

    // Robinhood monitor
    const rh = s.robinhood || {};
    const rhCard = el('div', { class: 'card', style: 'margin-top:14px' }, el('div', { class: 'card-h' }, el('h3', { class: 'title-3', text: 'Robinhood monitor' }), el('span', { class: `pill ${s.sources.robinhood.mode === 'live' ? 'live' : s.sources.robinhood.mode === 'demo' ? 'demo' : 'warn'}`, text: s.sources.robinhood.mode })));
    rhCard.append(el('div', { class: 'stat-mini' }, stat('Buying power', fmt.usd(rh.buying_power, 2)), stat('Holdings', String((rh.holdings || []).length)), stat('Fills (30d)', String((rh.recent_activity || []).length)),
      stat('Ledger match', (rh.reconciliation || []).length ? (rh.reconciliation.every(r => r.ok) ? 'OK' : `${rh.reconciliation.filter(r => !r.ok).length} off`) : '—')));
    if ((rh.recent_activity || []).length) {
      const tbl = el('table', { class: 'tbl' }, el('thead', null, el('tr', null, ...['Date', 'Side', 'Asset', 'Qty', 'Avg price', 'Notional'].map((h, i) => el('th', { class: i >= 3 ? 'r' : '', text: h })))));
      const tb = el('tbody'); for (const o of rh.recent_activity) tb.append(el('tr', null, el('td', { text: fmt.date(o.date) }), el('td', null, el('span', { class: `pill ${o.side === 'buy' ? 'long' : 'short'}`, text: (o.side || '').toUpperCase() })), el('td', { text: o.symbol }), el('td', { class: 'r num', text: fmt.num(o.quantity) }), el('td', { class: 'r num', text: fmt.price(o.avg_price) }), el('td', { class: 'r num', text: fmt.usd(o.notional, 2) })));
      tbl.append(tb); rhCard.append(el('div', { class: 'tbl-wrap', style: 'margin-top:12px' }, tbl));
    }
    rhCard.append(el('div', { class: 'muted-note', text: 'Read-only: this app never places orders. Robinhood is polled once per run for holdings, buying power, and fills, then reconciled against the Awaken tax ledger.' }));
    root.append(rhCard);
  }

  // ---------- Holdings ----------
  function renderHoldings(root) {
    const a = state.analytics, s = state.snapshot, total = a.totals.value;
    const list = el('div', { class: 'list' });
    for (const p of s.positions) {
      const plots = a.lots.filter(l => l.symbol === p.symbol);
      const basis = plots.reduce((x, l) => x + l.basis, 0) || p.cost_basis || 0, gain = p.value - basis;
      const wrap = el('div', { class: `row-wrap ${state.open.has(p.symbol) ? 'open' : ''}` });
      const row = el('div', { class: 'row clickable', role: 'button', tabindex: 0, 'aria-expanded': state.open.has(p.symbol), onclick: () => toggle(p.symbol, wrap), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(p.symbol, wrap); } } },
        avatar(p.symbol), el('div', { class: 'main' }, el('div', { class: 't', text: `${p.name || p.symbol}` }), el('div', { class: 's', text: `${fmt.num(p.quantity)} ${p.symbol} · ${fmt.price(p.price)} · ${fmt.pct(total ? p.value / total : 0, 1)}` })),
        el('div', { class: 'trail' }, el('div', { class: 't num', text: fmt.usd(p.value) }), el('div', { class: `s num ${gainClass(gain)}`, text: basis ? `${fmt.usdSigned(gain)} (${fmt.pctSigned(gain / basis, 0)})` : 'no basis' })), icon.chev());
      const detail = el('div', { class: 'detail' });
      if (plots.length) {
        const tbl = el('table', { class: 'tbl' }, el('thead', null, el('tr', null, ...['Bought', 'Account', 'Term', 'Units', 'Basis / unit', 'Basis', 'Value', 'Gain'].map((h, i) => el('th', { class: i >= 3 ? 'r' : '', text: h })))));
        const tb = el('tbody');
        for (const l of plots.sort((x, y) => x.purchased_at.localeCompare(y.purchased_at))) tb.append(el('tr', null,
          el('td', { text: l.age_unknown ? 'unknown' : fmt.date(l.purchased_at) }), el('td', { text: l.account || '—' }),
          el('td', null, el('span', { class: `pill ${l.term}`, text: l.term === 'long' ? 'Long' : `Short · ${l.days_to_long_term}d` })),
          el('td', { class: 'r num', text: fmt.num(l.amount) }), el('td', { class: 'r num', text: fmt.price(l.basis_per_unit) }), el('td', { class: 'r num', text: fmt.usd(l.basis) }), el('td', { class: 'r num', text: fmt.usd(l.value) }),
          el('td', { class: `r num ${gainClass(l.gain)}`, text: fmt.usdSigned(l.gain) })));
        tbl.append(tb); detail.append(el('div', { class: 'tbl-wrap' }, tbl));
      } else detail.append(el('div', { class: 'footnote secondary', text: 'No lot detail available for this position.' }));
      wrap.append(row, detail); list.append(wrap);
    }
    root.append(el('div', { class: 'list-header', text: `Holdings · ${fmt.usd(total)}` }), list, el('div', { class: 'list-footer', text: 'Tap a holding to see its tax lots.' }));
  }
  function toggle(sym, wrap) { state.open.has(sym) ? state.open.delete(sym) : state.open.add(sym); wrap.classList.toggle('open'); $('.row', wrap).setAttribute('aria-expanded', state.open.has(sym)); }
  const avatar = (sym) => el('span', { class: 'avatar', style: `background:${symColor(sym)}`, text: (sym || '?').slice(0, 4) });

  // ---------- charts ----------
  function sliceRange(history, range) {
    const n = history.length, days = { '1M': 31, '3M': 91, '1Y': 366, 'All': n }[range] || n;
    return history.slice(Math.max(0, n - days));
  }
  function lineChart(history, range) {
    // Render at the container's real pixel width so axis text stays legible on phones; redraw on resize.
    const wrap = el('div', { class: 'chart-wrap' });
    let lastW = 0;
    const draw = () => { const w = Math.max(280, Math.round(wrap.clientWidth || 640)); if (w === lastW) return; lastW = w; wrap.replaceChildren(...drawLineChart(history, range, w)); };
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(draw).observe(wrap); else requestAnimationFrame(draw);
    return wrap;
  }
  function drawLineChart(history, range, W) {
    const data = sliceRange(history || [], range).filter(h => h.value > 0);
    const H = Math.round(Math.min(260, Math.max(180, W * 0.38))), padL = 8, padR = 8, padT = 12, padB = 26;
    const wrap = { append: (...n) => out.push(...n) }, out = [];
    if (data.length < 2) { return [el('div', { class: 'empty', text: 'Not enough history yet — values accumulate one point per daily run.' })]; }
    const vals = data.map(d => d.value), lo = Math.min(...vals), hi = Math.max(...vals), span = (hi - lo) || 1;
    const x = (i) => padL + (i / (data.length - 1)) * (W - padL - padR), y = (v) => padT + (1 - (v - lo) / span) * (H - padT - padB);
    const svg = svgEl('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Portfolio value, ${fmt.usd(vals[0])} to ${fmt.usd(vals[vals.length - 1])}` });
    const ticks = niceTicks(lo, hi, 4);
    for (const t of ticks) { svg.append(svgEl('line', { class: 'grid-line', x1: padL, x2: W - padR, y1: y(t), y2: y(t) })); svg.append(svgEl('text', { class: 'axis-text', x: padL, y: y(t) - 4 }, compact(t))); }
    const pts = data.map((d, i) => `${x(i).toFixed(1)},${y(d.value).toFixed(1)}`);
    svg.append(svgEl('path', { class: 'area', d: `M${pts[0]} L${pts.join(' L')} L${x(data.length - 1).toFixed(1)},${H - padB} L${padL},${H - padB} Z` }));
    svg.append(svgEl('path', { class: 'line', d: `M${pts.join(' L')}` }));
    const step = Math.max(1, Math.floor(data.length / Math.max(2, Math.floor(W / 130))));
    for (let i = 0; i < data.length; i += step) svg.append(svgEl('text', { class: 'axis-text', x: x(i), y: H - 8, 'text-anchor': i === 0 ? 'start' : 'middle' }, range === '1M' || range === '3M' ? fmt.dateShort(data[i].date) : data[i].date.slice(0, 7)));
    const last = data[data.length - 1];
    svg.append(svgEl('circle', { class: 'dot', cx: x(data.length - 1), cy: y(last.value), r: 4 }));
    svg.append(svgEl('text', { class: 'axis-text', x: x(data.length - 1), y: y(last.value) - 10, 'text-anchor': 'end', style: 'font-weight:600;fill:var(--label)' }, fmt.usd(last.value)));
    const cross = svgEl('line', { class: 'cross', y1: padT, y2: H - padB, visibility: 'hidden' }), hover = svgEl('circle', { class: 'dot', r: 4, visibility: 'hidden' });
    svg.append(cross, hover);
    const tip = el('div', { class: 'tooltip' });
    wrap.append(svg, tip);
    const move = (evt) => {
      const rect = svg.getBoundingClientRect(), px = (evt.clientX - rect.left) / rect.width * W;
      const i = Math.max(0, Math.min(data.length - 1, Math.round((px - padL) / (W - padL - padR) * (data.length - 1))));
      cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('visibility', 'visible');
      hover.setAttribute('cx', x(i)); hover.setAttribute('cy', y(data[i].value)); hover.setAttribute('visibility', 'visible');
      const chg = i ? data[i].value / data[0].value - 1 : 0;
      tip.replaceChildren(el('div', { class: 'v num', text: fmt.usd(data[i].value) }), el('div', { class: 'k', text: fmt.date(data[i].date) }), el('div', { class: `k num ${gainClass(chg)}`, text: `${fmt.pctSigned(chg)} since ${fmt.dateShort(data[0].date)}` }));
      const left = Math.min(rect.width - 150, Math.max(0, (x(i) / W) * rect.width + 12));
      tip.style.left = left + 'px'; tip.style.top = Math.max(0, (y(data[i].value) / H) * rect.height - 60) + 'px'; tip.classList.add('show');
    };
    svg.addEventListener('pointermove', move); svg.addEventListener('pointerleave', () => { tip.classList.remove('show'); cross.setAttribute('visibility', 'hidden'); hover.setAttribute('visibility', 'hidden'); });
    return out;
  }
  function niceTicks(lo, hi, n) { const span = (hi - lo) || 1, raw = span / n, mag = 10 ** Math.floor(Math.log10(raw)), step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw) || mag; const out = []; for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) out.push(v); return out; }
  const compact = (v) => v >= 1e6 ? '$' + (v / 1e6).toFixed(2) + 'M' : v >= 1e3 ? '$' + Math.round(v / 1e3).toLocaleString() + 'k' : '$' + Math.round(v);

  function allocation(positions, total) {
    const wrap = el('div');
    const sorted = [...positions].sort((a, b) => b.value - a.value);
    const top = sorted.slice(0, 7), other = sorted.slice(7);
    const rows = top.map(p => ({ label: p.symbol, value: p.value, color: symColor(p.symbol) }));
    if (other.length) rows.push({ label: 'Other', value: other.reduce((a, p) => a + p.value, 0), color: 'var(--gray)' });
    const bar = el('div', { class: 'alloc-bar', role: 'img', 'aria-label': rows.map(r => `${r.label} ${fmt.pct(r.value / total, 0)}`).join(', ') });
    const tip = el('div', { class: 'tooltip' }); const cw = el('div', { class: 'chart-wrap' }, bar, tip);
    for (const r of rows) {
      const seg = el('span', { style: `width:${(100 * r.value / total).toFixed(2)}%;background:${r.color}`, tabindex: 0, 'aria-label': `${r.label} ${fmt.usd(r.value)}` });
      const show = (e) => { tip.replaceChildren(el('div', { class: 'v num', text: fmt.pct(r.value / total, 1) }), el('div', { class: 'k', text: `${r.label} · ${fmt.usd(r.value)}` })); const rect = cw.getBoundingClientRect(); const cx = e && e.clientX ? e.clientX - rect.left : seg.offsetLeft; tip.style.left = Math.min(rect.width - 140, Math.max(0, cx - 60)) + 'px'; tip.style.top = '22px'; tip.classList.add('show'); };
      seg.addEventListener('pointermove', show); seg.addEventListener('focus', show); seg.addEventListener('pointerleave', () => tip.classList.remove('show')); seg.addEventListener('blur', () => tip.classList.remove('show'));
      bar.append(seg);
    }
    const legend = el('div', { class: 'legend' }, ...rows.map(r => el('span', { class: 'li' }, el('i', { class: 'sw', style: `background:${r.color}` }), el('b', { text: r.label }), ` ${fmt.pct(r.value / total, 0)}`)));
    wrap.append(cw, legend);
    return wrap;
  }

  function gainLossBars(positions, lots) {
    const rows = positions.map(p => { const pl = lots.filter(l => l.symbol === p.symbol); const basis = pl.reduce((a, l) => a + l.basis, 0) || p.cost_basis || 0; return { sym: p.symbol, gain: p.value - basis }; }).sort((a, b) => b.gain - a.gain);
    const mx = Math.max(1, ...rows.map(r => Math.abs(r.gain)));
    const box = el('div', { class: 'hbars' });
    for (const r of rows) {
      const w = 50 * Math.abs(r.gain) / mx;
      box.append(el('div', { class: 'hbar' }, el('span', { class: 'headline', style: 'font-size:13px', text: r.sym }),
        el('div', { class: 'track', title: `${r.sym} ${fmt.usdSigned(r.gain)}` }, el('i', { class: 'zero' }), el('i', { class: `bar ${r.gain < 0 ? 'neg' : ''}`, style: `background:${r.gain >= 0 ? 'var(--gain)' : 'var(--loss)'};width:${w}%;${r.gain >= 0 ? 'left:50%' : `right:50%`}` })),
        el('span', { class: `val num ${gainClass(r.gain)}`, text: fmt.usdSigned(r.gain) })));
    }
    return box;
  }

  function sparkline(series, sym, sig) {
    const W = 200, H = 96, wrap = el('div', { class: 'chart-wrap' });
    if (!series || series.length < 2) { wrap.append(el('div', { class: 'footnote secondary', text: 'No price history.' })); return wrap; }
    const lo = Math.min(...series), hi = Math.max(...series), span = (hi - lo) || 1;
    const x = (i) => (i / (series.length - 1)) * W, y = (v) => 6 + (1 - (v - lo) / span) * (H - 26);
    const svg = svgEl('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `${sym} price, last ${series.length} days` });
    if (sig && sig.sma50) svg.append(svgEl('line', { class: 'spark-ref', x1: 0, x2: W, y1: y(sig.sma50), y2: y(sig.sma50) }));
    if (sig && sig.high_90d) svg.append(svgEl('line', { class: 'spark-ref', x1: 0, x2: W, y1: y(sig.high_90d), y2: y(sig.high_90d), 'stroke-dasharray': '2 3' }));
    svg.append(svgEl('path', { class: 'spark-line', style: `stroke:${symColor(sym)}`, d: 'M' + series.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' L') }));
    svg.append(svgEl('circle', { cx: W, cy: y(series[series.length - 1]), r: 4, style: `fill:${symColor(sym)};stroke:var(--bg-elevated);stroke-width:2` }));
    svg.append(svgEl('text', { class: 'axis-text', x: 0, y: H - 4 }, `${series.length}d`), svgEl('text', { class: 'axis-text', x: W, y: H - 4, 'text-anchor': 'end' }, fmt.price(series[series.length - 1])));
    const legend = el('div', { class: 'legend', style: 'margin-top:4px;font-size:11px' }, el('span', { class: 'li' }, el('i', { class: 'ln', style: `background:${symColor(sym)}` }), 'price'), el('span', { class: 'li' }, el('i', { class: 'ln', style: 'background:var(--label-3)' }), '50d avg'), el('span', { class: 'li' }, el('i', { class: 'ln', style: 'background:var(--label-3);height:0;border-top:2px dashed var(--label-3)' }), '90d high'));
    const tip = el('div', { class: 'tooltip' }); wrap.append(svg, tip, legend);
    svg.addEventListener('pointermove', (e) => { const rect = svg.getBoundingClientRect(); const i = Math.max(0, Math.min(series.length - 1, Math.round((e.clientX - rect.left) / rect.width * (series.length - 1)))); tip.replaceChildren(el('div', { class: 'v num', text: fmt.price(series[i]) }), el('div', { class: 'k', text: `${series.length - 1 - i} days ago` })); tip.style.left = Math.min(rect.width - 120, Math.max(0, (i / (series.length - 1)) * rect.width - 40)) + 'px'; tip.style.top = '-6px'; tip.classList.add('show'); });
    svg.addEventListener('pointerleave', () => tip.classList.remove('show'));
    return wrap;
  }

  // ---------- Settings sheet ----------
  const FIELDS = [
    ['Tax rates', [
      ['short_term_rate', 'Short-term (ordinary) rate', '%'], ['long_term_rate', 'Long-term capital gains rate', '%'], ['state_rate', 'State rate', '%'], ['niit_rate', 'Net investment income tax', '%'], ['ordinary_income_offset', 'Annual loss vs. ordinary income', '$']]],
    ['Harvesting', [['min_harvest_loss', 'Minimum loss to flag', '$'], ['min_harvest_loss_pct', '…or minimum loss vs. basis', '%'], ['wash_sale_conservative', 'Conservative 31-day re-buy wait', 'bool']]],
    ['Profit taking', [['profit_take_gain_pct', 'Flag winners up at least', '%'], ['max_weight', 'Single-asset ceiling', '%'], ['target_weight', 'Trim back to', '%'], ['trailing_dd_pct', 'Fading: below 90-day high by', '%'], ['long_term_wait_days', 'Suggest waiting if long-term within', 'days']]],
  ];
  function openSettings() {
    const draft = { ...state.settings };
    const sheet = $('#sheet'), body = $('#sheetBody'); body.replaceChildren();
    for (const [group, fields] of FIELDS) {
      const list = el('div', { class: 'list form' });
      for (const [key, label, unit] of fields) {
        if (unit === 'bool') { const sw = el('button', { class: 'switch', role: 'switch', 'aria-checked': String(!!draft[key]), 'aria-label': label, onclick: () => { draft[key] = !draft[key]; sw.setAttribute('aria-checked', String(draft[key])); } }); list.append(el('div', { class: 'row no-icon' }, el('div', { class: 'main' }, el('div', { class: 't', text: label })), sw)); continue; }
        const isPct = unit === '%', input = el('input', { type: 'number', step: isPct ? '0.1' : '1', inputmode: 'decimal', value: isPct ? +(draft[key] * 100).toFixed(2) : draft[key], 'aria-label': label, oninput: (e) => { const v = parseFloat(e.target.value); if (!isNaN(v)) draft[key] = isPct ? v / 100 : v; } });
        list.append(el('div', { class: 'row no-icon' }, el('div', { class: 'main' }, el('div', { class: 't', text: label })), input, el('span', { class: 'unit', text: unit })));
      }
      body.append(el('div', { class: 'list-header', text: group }), list);
    }
    body.append(el('div', { class: 'list-footer' }, 'Settings are stored in this browser only. The daily job uses portfolio/settings.json in the repo — edit that file to change what the push alerts use.'));
    body.append(el('div', { style: 'display:flex;justify-content:center;margin-top:14px' }, el('button', { class: 'text-btn', onclick: () => { localStorage.removeItem(SETTINGS_KEY); state.settings = { ...A.DEFAULTS, ...(state.snapshot.analytics.settings || {}) }; recompute(); renderAll(); closeSettings(); } }, 'Reset to repository settings')));
    $('#sheetDone').onclick = () => { state.settings = draft; localStorage.setItem(SETTINGS_KEY, JSON.stringify(draft)); recompute(); renderAll(); closeSettings(); };
    sheet.classList.add('show'); $('#backdrop').classList.add('show'); sheet.setAttribute('aria-hidden', 'false');
  }
  function closeSettings() { $('#sheet').classList.remove('show'); $('#backdrop').classList.remove('show'); $('#sheet').setAttribute('aria-hidden', 'true'); }

  // ---------- boot ----------
  document.addEventListener('DOMContentLoaded', () => {
    applyTheme(localStorage.getItem(THEME_KEY) || null);
    $('#themeBtn').addEventListener('click', () => { const next = isDark() ? 'light' : 'dark'; localStorage.setItem(THEME_KEY, next); applyTheme(next); });
    $('#settingsBtn').addEventListener('click', openSettings); $('#sheetCancel').addEventListener('click', closeSettings); $('#backdrop').addEventListener('click', closeSettings);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSettings(); });
    document.querySelectorAll('#tabs button').forEach(b => b.addEventListener('click', () => { state.tab = b.dataset.tab; renderTab(); }));
    const nav = $('#nav'); addEventListener('scroll', () => nav.classList.toggle('compact', scrollY > 48), { passive: true });
    load();
  });
})();
