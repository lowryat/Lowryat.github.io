/* Shadow trading dashboard.
   Reads ../reports/shadow/latest.json, written daily by
   `python -m tradingbot.shadow` in the tradingbot-shadow workflow.

   The page is ordered to answer one question first — "is this ready for real
   money?" — and only then shows the detail backing that answer. */

const SERIES = ['--s1', '--s2', '--s3', '--s4', '--s5', '--s6', '--s7', '--s8'];
const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

const fmtMoney = (v) => (v == null ? '—' : '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const fmtPct = (v, d = 2) => (v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(d) + '%');
const fmtNum = (v, d = 2) => (v == null ? '—' : v.toFixed(d));
const signClass = (v) => (v == null ? '' : v >= 0 ? 'pos' : 'neg');

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null) continue;
    n.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return n;
}

function card(title, ...body) {
  return el('section', { class: 'card' },
    title ? el('div', { class: 'card-h' }, el('h2', { class: 'title-3' }, title)) : null,
    ...body);
}

/* ---------------------------------------------------------------- verdict */
/* Deliberately conservative. The failure mode that costs real money is
   deploying on a short, lucky sample, so the gates are about evidence
   sufficiency first and performance second. */
function computeVerdict(d) {
  const ens = d.ensemble || {};
  const bars = d.bars || 0;
  const trades = ens.n_trades || 0;
  const weeklyLimit = (d.limits?.weekly_dd ?? 0.05) * 100;
  const worstWeekly = (ens.worst_weekly ?? 0) * 100;
  const net = ens.net_return_pct ?? 0;

  // Synthetic data can never justify a go-live decision, however good it
  // looks. Say so plainly rather than letting a green tick imply evidence
  // that does not exist.
  if (!/live/i.test(d.data_source || '')) {
    return {
      cls: 'wait', icon: '○', title: 'Synthetic data — not evidence',
      text: `This run used ${d.data_source}, not real market prices. The numbers below exercise the plumbing but say nothing about whether the strategies work. Real bars arrive once the daily shadow job runs.`
    };
  }

  const blockers = [];
  if (bars < 90) blockers.push(`only ${bars} days of market data (want 90+)`);
  if (trades < 20) blockers.push(`only ${trades} closed trades (want 20+ for a meaningful win rate)`);
  if (worstWeekly > weeklyLimit) blockers.push(`worst week −${worstWeekly.toFixed(2)}% breached the ${weeklyLimit}% limit`);
  if (net <= 0) blockers.push(`ensemble is ${fmtPct(net)} net of costs`);

  if (blockers.length === 0) {
    return {
      cls: 'go', icon: '✓', title: 'Evidence supports a small live paper test',
      text: `${bars} days, ${trades} trades, worst week −${worstWeekly.toFixed(2)}% (inside the ${weeklyLimit}% limit), ensemble ${fmtPct(net)} net. That clears the evidence bar — it is not a prediction. Next step is Alpaca paper with real order execution, not real money.`
    };
  }
  const severe = worstWeekly > weeklyLimit;
  return {
    cls: severe ? 'stop' : 'wait',
    icon: severe ? '✕' : '○',
    title: severe ? 'Not ready — a hard risk limit was breached' : 'Not ready — keep collecting data',
    text: blockers.join(' · ') + '.'
  };
}

/* ------------------------------------------------------------------ chart */
function equityChart(series, width = 760, height = 240) {
  const pad = { t: 10, r: 12, b: 22, l: 52 };
  const all = series.flatMap((s) => s.points);
  if (!all.length) return el('p', { class: 'empty-note' }, 'No equity history yet.');

  const dates = [...new Set(all.map((p) => p.date))].sort();
  const xi = new Map(dates.map((d, i) => [d, i]));
  const ys = all.map((p) => p.equity);
  let lo = Math.min(...ys), hi = Math.max(...ys);
  if (hi === lo) { hi += 1; lo -= 1; }
  const padY = (hi - lo) * 0.08; lo -= padY; hi += padY;

  const X = (d) => pad.l + (xi.get(d) / Math.max(1, dates.length - 1)) * (width - pad.l - pad.r);
  const Y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * (height - pad.t - pad.b);

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('class', 'chart-svg');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label',
    'Equity curves: ' + series.map((s) => `${s.label} ending ${fmtMoney(s.points.at(-1)?.equity)}`).join('; '));

  const mk = (t, a) => {
    const n = document.createElementNS('http://www.w3.org/2000/svg', t);
    for (const [k, v] of Object.entries(a)) n.setAttribute(k, v);
    return n;
  };

  // horizontal gridlines + y labels
  for (let i = 0; i <= 4; i++) {
    const v = lo + (hi - lo) * (i / 4);
    svg.append(mk('line', { x1: pad.l, x2: width - pad.r, y1: Y(v), y2: Y(v), stroke: cssVar('--grid'), 'stroke-width': 1 }));
    const lbl = mk('text', { x: pad.l - 7, y: Y(v) + 3.5, 'text-anchor': 'end', fill: cssVar('--label-2'), 'font-size': 10 });
    lbl.textContent = '$' + Math.round(v).toLocaleString('en-US');
    svg.append(lbl);
  }
  // baseline (starting capital) so gain/loss is readable at a glance
  const base = series[0]?.baseline;
  if (base != null && base > lo && base < hi) {
    svg.append(mk('line', {
      x1: pad.l, x2: width - pad.r, y1: Y(base), y2: Y(base),
      stroke: cssVar('--label-3'), 'stroke-width': 1, 'stroke-dasharray': '3 3'
    }));
  }
  // x labels (first / mid / last)
  [0, Math.floor(dates.length / 2), dates.length - 1].forEach((i) => {
    if (i < 0 || i >= dates.length) return;
    const t = mk('text', { x: X(dates[i]), y: height - 6, 'text-anchor': i === 0 ? 'start' : i === dates.length - 1 ? 'end' : 'middle', fill: cssVar('--label-2'), 'font-size': 10 });
    t.textContent = dates[i].slice(5);
    svg.append(t);
  });
  // series
  series.forEach((s, i) => {
    const pts = s.points.filter((p) => xi.has(p.date));
    if (!pts.length) return;
    svg.append(mk('path', {
      d: pts.map((p, j) => `${j ? 'L' : 'M'}${X(p.date).toFixed(1)},${Y(p.equity).toFixed(1)}`).join(' '),
      fill: 'none', stroke: cssVar(SERIES[i % SERIES.length]),
      'stroke-width': s.emphasis ? 2.6 : 1.5,
      'stroke-linejoin': 'round', 'stroke-linecap': 'round',
      opacity: s.emphasis ? 1 : 0.75
    }));
  });
  return svg;
}

/* ------------------------------------------------------------------ gauge */
function ddGauge(label, value, limit, note) {
  const pctOfLimit = limit ? Math.min(100, (value / limit) * 100) : 0;
  const breached = value > limit;
  const near = !breached && value > limit * 0.75;
  const color = breached ? cssVar('--red') : near ? cssVar('--orange') : cssVar('--green');
  return el('div', { class: 'gauge' },
    el('div', { class: 'gauge-top' },
      el('span', {}, label),
      el('span', { class: 'g-val', style: `color:${color}` },
        `−${(value * 100).toFixed(2)}% of ${(limit * 100).toFixed(0)}% limit`)),
    el('div', { class: 'gauge-track' },
      el('div', { class: 'gauge-fill', style: `width:${pctOfLimit}%;background:${color}` }),
      el('div', { class: 'gauge-limit', style: 'right:0' })),
    note ? el('div', { class: 'gauge-note' }, note) : null);
}

/* ------------------------------------------------------------------ render */
function render(d) {
  const ens = d.ensemble || {};
  const variants = d.variants || [];

  document.getElementById('sub').textContent =
    `${d.bars} daily bars · ${d.period.start} → ${d.period.end} · ${d.symbols.join(', ')} · ${d.data_source}`;

  // Verdict
  const v = computeVerdict(d);
  document.getElementById('verdict').replaceChildren(
    el('div', { class: `verdict ${v.cls}` },
      el('div', { class: 'vicon' }, v.icon),
      el('div', { class: 'vbody' },
        el('div', { class: 'vtitle' }, v.title),
        el('div', { class: 'vtext' }, v.text))));

  // KPIs — ensemble is the deployment candidate, so it leads
  const kpi = (label, value, sub, cls) =>
    el('div', { class: 'kpi-card' },
      el('div', { class: 'k-label' }, label),
      el('div', { class: `k-value ${cls || ''}` }, value),
      sub ? el('div', { class: 'k-sub' }, sub) : null);

  document.getElementById('kpis').replaceChildren(
    el('div', { class: 'kpi-grid' },
      kpi('Ensemble net', fmtPct(ens.net_return_pct), `gross ${fmtPct(ens.gross_return_pct)}`, signClass(ens.net_return_pct)),
      kpi('Equity', fmtMoney(ens.net_equity), `from ${fmtMoney(ens.allocation)}`),
      kpi('Worst week', `−${((ens.worst_weekly || 0) * 100).toFixed(2)}%`,
        `limit ${(d.limits.weekly_dd * 100).toFixed(0)}%`,
        (ens.worst_weekly || 0) > d.limits.weekly_dd ? 'neg' : 'pos'),
      kpi('Closed trades', String(ens.n_trades ?? 0), `${d.bars} days of data`),
      kpi('Est. costs', fmtMoney(ens.estimated_costs), `${d.cost_bps}bp per side`)));

  // Equity curves
  const series = variants.map((x) => ({
    label: x.label, baseline: x.allocation,
    points: x.equity_curve.map((p) => ({ date: p.date, equity: p.equity / x.allocation * 100 }))
  }));
  if (ens.equity_curve) {
    series.unshift({
      label: 'ENSEMBLE', emphasis: true, baseline: 100,
      points: ens.equity_curve.map((p) => ({ date: p.date, equity: p.equity / ens.allocation * 100 }))
    });
  }
  document.getElementById('equity').replaceChildren(
    card('Equity curves (indexed to 100)',
      el('div', { class: 'chart-wrap' }, equityChart(series)),
      el('div', { class: 'legend-row' },
        series.map((s, i) => el('div', { class: 'li' },
          el('span', { class: 'sw', style: `background:${cssVar(SERIES[i % SERIES.length])}` }),
          s.label)))));

  // Risk vs limits
  document.getElementById('risk').replaceChildren(
    card('Risk against the hard limits',
      ddGauge('Worst single day (ensemble)', ens.worst_daily || 0, d.limits.daily_dd,
        'The circuit breaker flattens everything past this line.'),
      ddGauge('Worst week (ensemble)', ens.worst_weekly || 0, d.limits.weekly_dd,
        'Breaching this is the one disqualifying failure.'),
      el('p', { class: 'caption-2', style: 'margin-top:8px' },
        'Daily bars can gap through a stop, so a breach is possible even with the breaker working. What matters is whether it happens and how often.')));

  // Leaderboard
  const rows = variants.slice().sort((a, b) => (b.net_return_pct ?? 0) - (a.net_return_pct ?? 0));
  const ddBadge = (x) => {
    const w = x.worst_weekly || 0, lim = d.limits.weekly_dd;
    const cls = w > lim ? 'bad' : w > lim * 0.75 ? 'warn' : 'ok';
    return el('span', { class: `badge ${cls}` }, `−${(w * 100).toFixed(2)}%`);
  };
  document.getElementById('leaderboard').replaceChildren(
    card('Per-bot comparison',
      el('div', { class: 'tbl-scroll' },
        el('table', { class: 'shadow-tbl' },
          el('thead', {}, el('tr', {},
            ['Bot', 'Net', 'Gross', 'Trades', 'Win %', 'Avg R', 'Profit factor', 'Worst wk', 'CB'].map((h) => el('th', {}, h)))),
          el('tbody', {},
            rows.map((x) => el('tr', {},
              el('td', {}, x.label),
              el('td', { class: signClass(x.net_return_pct) }, fmtPct(x.net_return_pct)),
              el('td', { class: 'muted-note' }, fmtPct(x.gross_return_pct)),
              el('td', {}, String(x.n_trades)),
              el('td', {}, x.win_rate == null ? '—' : x.win_rate.toFixed(0) + '%'),
              el('td', { class: signClass(x.avg_r) }, fmtNum(x.avg_r)),
              el('td', {}, fmtNum(x.profit_factor)),
              el('td', {}, ddBadge(x)),
              el('td', {}, String(x.cb_trips ?? 0)))),
            ens.label ? el('tr', { class: 'highlight' },
              el('td', {}, 'ENSEMBLE'),
              el('td', { class: signClass(ens.net_return_pct) }, fmtPct(ens.net_return_pct)),
              el('td', { class: 'muted-note' }, fmtPct(ens.gross_return_pct)),
              el('td', {}, String(ens.n_trades)),
              el('td', {}, '—'), el('td', {}, '—'), el('td', {}, '—'),
              el('td', {}, el('span', {
                class: `badge ${(ens.worst_weekly || 0) > d.limits.weekly_dd ? 'bad' : 'ok'}`
              }, `−${((ens.worst_weekly || 0) * 100).toFixed(2)}%`)),
              el('td', {}, '—')) : null))),
      el('p', { class: 'caption-2', style: 'margin-top:9px' },
        'Net is after estimated fees and slippage. Profit factor is gross wins ÷ gross losses; above 1.0 is profitable, above 1.5 is healthy.')));

  // Open positions
  const open = variants.flatMap((x) => (x.open_positions || []).map((p) => ({ ...p, bot: x.label })));
  document.getElementById('positions').replaceChildren(
    card(`Open positions (${open.length})`,
      open.length === 0
        ? el('p', { class: 'empty-note' }, 'All bots are flat. Entries need a trend signal plus the regime filter, so flat stretches are normal and expected.')
        : el('div', { class: 'tbl-scroll' },
          el('table', { class: 'shadow-tbl' },
            el('thead', {}, el('tr', {}, ['Bot', 'Sym', 'Qty', 'Entry', 'Now', 'Stop', '% to stop', 'Open R'].map((h) => el('th', {}, h)))),
            el('tbody', {}, open.map((p) => el('tr', {},
              el('td', {}, p.bot),
              el('td', {}, p.symbol),
              el('td', {}, p.qty.toFixed(4)),
              el('td', {}, fmtMoney(p.entry_price)),
              el('td', {}, fmtMoney(p.current_price)),
              el('td', {}, fmtMoney(p.stop)),
              el('td', {}, p.pct_to_stop == null ? '—' : p.pct_to_stop.toFixed(1) + '%'),
              el('td', { class: signClass(p.r_multiple) }, fmtNum(p.r_multiple)))))))));

  // Recent closed trades
  const trades = variants.flatMap((x) => (x.trades || []).map((t) => ({ ...t, bot: x.label })))
    .sort((a, b) => (a.exit_date < b.exit_date ? 1 : -1)).slice(0, 25);
  document.getElementById('trades').replaceChildren(
    card(`Recent closed trades (${trades.length} of ${variants.reduce((s, x) => s + x.n_trades, 0)})`,
      trades.length === 0
        ? el('p', { class: 'empty-note' }, 'No closed trades yet.')
        : el('div', { class: 'tbl-scroll' },
          el('table', { class: 'shadow-tbl' },
            el('thead', {}, el('tr', {}, ['Exit', 'Bot', 'Sym', 'Reason', 'P&L', 'R'].map((h) => el('th', {}, h)))),
            el('tbody', {}, trades.map((t) => el('tr', {},
              el('td', {}, t.exit_date),
              el('td', {}, t.bot),
              el('td', {}, t.symbol),
              el('td', {}, t.exit_reason),
              el('td', { class: signClass(t.pnl) }, fmtMoney(t.pnl)),
              el('td', { class: signClass(t.r_multiple) }, fmtNum(t.r_multiple)))))))),
  );
}

/* ------------------------------------------------------------------- boot */
function banner(kind, title, body) {
  return el('div', { class: `banner ${kind}` },
    el('strong', {}, title), body ? el('div', { class: 'caption-2' }, body) : null);
}

(function theme() {
  const btn = document.getElementById('themeBtn');
  const apply = (t) => {
    document.documentElement.setAttribute('data-theme', t);
    btn.textContent = t === 'dark' ? '☀' : '☾';
  };
  let saved = null;
  try { saved = localStorage.getItem('shadow-theme'); } catch (_) { /* private mode */ }
  apply(saved || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  btn.addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    apply(next);
    try { localStorage.setItem('shadow-theme', next); } catch (_) { /* ignore */ }
  });
})();

(async function load() {
  const status = document.getElementById('status');
  try {
    const url = new URL('../reports/shadow/latest.json', location.href);
    const res = await fetch(url.toString(), { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    render(await res.json());
  } catch (e) {
    document.getElementById('sub').textContent = '';
    status.replaceChildren(banner('err', 'Could not load reports/shadow/latest.json',
      `${e.message}. Run "python -m tradingbot.shadow --demo" and serve the repo root ` +
      `(python -m http.server) — a file:// URL cannot fetch JSON.`));
  }
})();
