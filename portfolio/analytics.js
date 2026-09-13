/* Mirror of portfolio_analytics/analytics.py so the dashboard can recompute
   insights client-side when the user changes tax rates or thresholds.
   Keep the two in lock-step: tests/test_portfolio_analytics.py pins the Python
   numbers, and the demo snapshot is the shared fixture. */
(function (global) {
  'use strict';

  const DEFAULTS = {
    short_term_rate: 0.35, long_term_rate: 0.20, state_rate: 0.0, niit_rate: 0.038,
    long_term_days: 365, ordinary_income_offset: 3000,
    min_harvest_loss: 250, min_harvest_loss_pct: 0.05, profit_take_gain_pct: 0.5,
    max_weight: 0.35, target_weight: 0.25, trailing_dd_pct: 0.15, long_term_wait_days: 45,
    wash_sale_conservative: false,
  };

  const DAY = 86400000;
  const toDate = (s) => new Date(String(s).slice(0, 10) + 'T00:00:00Z');
  const iso = (d) => d.toISOString().slice(0, 10);
  const div = (a, b) => (b ? a / b : 0);
  const shortRate = (s) => s.short_term_rate + s.state_rate + s.niit_rate;
  const longRate = (s) => s.long_term_rate + s.state_rate + s.niit_rate;

  function lotTerm(purchasedAt, asOf, longTermDays) {
    const bought = toDate(purchasedAt), today = toDate(asOf);
    const holding = Math.round((today - bought) / DAY);
    const longOn = new Date(bought.getTime() + (longTermDays + 1) * DAY);
    const isLong = holding > longTermDays;
    return {
      holding_days: holding, term: isLong ? 'long' : 'short',
      days_to_long_term: isLong ? 0 : Math.max(0, Math.round((longOn - today) / DAY)),
      long_term_on: iso(longOn),
    };
  }

  function enrichLots(positions, asOf, s) {
    const out = [];
    for (const pos of positions) {
      const price = Number(pos.price || 0);
      (pos.lots || []).forEach((lot, i) => {
        const amount = Number(lot.amount || 0), basis = Number(lot.basis || 0);
        if (amount <= 0) return;
        const term = lotTerm(lot.purchased_at, asOf, s.long_term_days);
        const value = amount * price, gain = value - basis;
        out.push({
          id: lot.id || `${pos.symbol}-${i}`, symbol: pos.symbol, account: lot.account || pos.account || '',
          amount, basis, basis_per_unit: div(basis, amount), purchased_at: String(lot.purchased_at).slice(0, 10),
          price, value, gain, gain_pct: div(gain, basis), tax_rate: term.term === 'long' ? longRate(s) : shortRate(s),
          age_unknown: !!lot.age_unknown, ...term,
        });
      });
    }
    return out;
  }

  function harvestCandidates(lots, s, asOf) {
    const out = [];
    for (const lot of lots) {
      const loss = -lot.gain;
      if (loss <= 0) continue;
      if (loss < s.min_harvest_loss && loss < s.min_harvest_loss_pct * lot.basis) continue;
      out.push({ ...lot, loss, est_tax_savings: loss * lot.tax_rate,
        rebuy_caution_until: s.wash_sale_conservative ? iso(new Date(toDate(asOf).getTime() + 31 * DAY)) : null });
    }
    return out.sort((a, b) => b.est_tax_savings - a.est_tax_savings);
  }

  function harvestSummary(cands, realized, s) {
    const shortLoss = cands.filter(c => c.term === 'short').reduce((a, c) => a + c.loss, 0);
    const longLoss = cands.filter(c => c.term === 'long').reduce((a, c) => a + c.loss, 0);
    const rS = Number((realized || {}).short_term || 0), rL = Number((realized || {}).long_term || 0);
    let netS = rS - shortLoss, netL = rL - longLoss;
    if (netS < 0 && netL > 0) { const m = Math.min(-netS, netL); netS += m; netL -= m; }
    else if (netL < 0 && netS > 0) { const m = Math.min(-netL, netS); netL += m; netS -= m; }
    const netT = netS + netL;
    const offset = netT < 0 ? Math.min(s.ordinary_income_offset, -netT) : 0;
    const carry = Math.max(0, -netT - offset);
    const before = Math.max(rS, 0) * shortRate(s) + Math.max(rL, 0) * longRate(s);
    const after = Math.max(netS, 0) * shortRate(s) + Math.max(netL, 0) * longRate(s) - offset * shortRate(s);
    return { candidates: cands.length, short_term_loss: shortLoss, long_term_loss: longLoss, total_loss: shortLoss + longLoss,
      realized_short_term: rS, realized_long_term: rL, net_short_after: netS, net_long_after: netL, net_total_after: netT,
      ordinary_income_offset: offset, carryforward: carry, est_tax_before: before, est_tax_after: after,
      est_tax_savings: Math.max(0, before - after) };
  }

  const sma = (v, w) => (v.length < w || w <= 0) ? null : v.slice(-w).reduce((a, b) => a + b, 0) / w;

  function priceSignals(hist, s) {
    if (!hist || hist.length < 2) return { available: false };
    const c = hist.map(Number), last = c[c.length - 1], hi90 = Math.max(...c.slice(-90));
    const dd = hi90 ? 1 - last / hi90 : 0, s20 = sma(c, 20), s50 = sma(c, 50);
    return { available: true, last, high_90d: hi90, drawdown_from_90d_high: dd, sma20: s20, sma50: s50,
      above_sma50: s50 ? last > s50 : null, return_30d: c.length > 30 ? div(last, c[c.length - 31]) - 1 : null,
      fading: dd >= s.trailing_dd_pct };
  }

  function taxCostOfSale(lots, amount, method) {
    method = (method || 'HIFO').toUpperCase();
    let ordered = [...lots];
    if (method === 'FIFO') ordered.sort((a, b) => a.purchased_at.localeCompare(b.purchased_at));
    else if (method === 'LIFO') ordered.sort((a, b) => b.purchased_at.localeCompare(a.purchased_at));
    else ordered.sort((a, b) => b.basis_per_unit - a.basis_per_unit);
    let rem = amount, gain = 0, tax = 0, proceeds = 0; const used = [];
    for (const lot of ordered) {
      if (rem <= 1e-12) break;
      const take = Math.min(rem, lot.amount), g = take * (lot.price - lot.basis_per_unit);
      gain += g; tax += Math.max(g, 0) * lot.tax_rate; proceeds += take * lot.price;
      used.push({ lot_id: lot.id, amount: take, gain: g, term: lot.term }); rem -= take;
    }
    return { method, amount: amount - rem, proceeds, realized_gain: gain, est_tax: tax, lots_used: used };
  }

  function profitTakeCandidates(positions, lots, total, s, priceHistory, method) {
    priceHistory = priceHistory || {};
    const bySym = {};
    lots.forEach(l => (bySym[l.symbol] = bySym[l.symbol] || []).push(l));
    const out = [];
    for (const pos of positions) {
      const pl = bySym[pos.symbol] || [], value = Number(pos.value || 0);
      const basis = pl.reduce((a, l) => a + l.basis, 0) || Number(pos.cost_basis || 0);
      const gain = value - basis, gainPct = div(gain, basis), weight = div(value, total);
      const sig = priceSignals(priceHistory[pos.symbol], s);
      const reasons = [];
      if (weight > s.max_weight) reasons.push('concentration');
      if (basis > 0 && gainPct >= s.profit_take_gain_pct) reasons.push('big_winner');
      if (sig.fading && gain > 0) reasons.push('fading');
      if (!reasons.length) continue;
      let trim;
      if (reasons.includes('concentration')) trim = Math.max(0, value - s.target_weight * total);
      else if (reasons.includes('fading')) trim = 0.5 * value;
      else trim = Math.min(value, Math.max(gain * 0.5, 0));
      const units = div(trim, Number(pos.price || 0));
      const sale = pl.length ? taxCostOfSale(pl, units, method) : null;
      const soon = pl.filter(l => l.term === 'short' && l.gain > 0 && l.days_to_long_term <= s.long_term_wait_days);
      let wait = null;
      if (soon.length) {
        wait = { lots: soon.length, max_days: Math.max(...soon.map(l => l.days_to_long_term)),
          est_tax_saved_by_waiting: soon.reduce((a, l) => a + l.gain * (shortRate(s) - longRate(s)), 0),
          gain_at_stake: soon.reduce((a, l) => a + l.gain, 0) };
      }
      out.push({ symbol: pos.symbol, reasons, weight, value, basis, gain, gain_pct: gainPct, trim_value: trim,
        trim_units: units, sale, wait_for_long_term: wait, signals: sig });
    }
    const pr = { concentration: 0, fading: 1, big_winner: 2 };
    return out.sort((a, b) => (Math.min(...a.reasons.map(r => pr[r])) - Math.min(...b.reasons.map(r => pr[r]))) || (b.gain - a.gain));
  }

  function riskMetrics(history, weights, rf = 0.04, ppy = 365) {
    const v = history.map(h => Number(h.value)).filter(x => x > 0);
    const out = { days: v.length };
    if (v.length >= 2) {
      const rets = v.slice(1).map((x, i) => x / v[i] - 1);
      const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
      const varr = rets.reduce((a, r) => a + (r - mean) ** 2, 0) / Math.max(1, rets.length - 1);
      const vol = Math.sqrt(varr) * Math.sqrt(ppy);
      const ann = (v[v.length - 1] / v[0]) ** (ppy / Math.max(1, rets.length)) - 1;
      let peak = v[0], mdd = 0;
      for (const x of v) { peak = Math.max(peak, x); mdd = Math.max(mdd, 1 - x / peak); }
      const dn = rets.map(r => Math.min(0, r)), dvol = Math.sqrt(dn.reduce((a, d) => a + d * d, 0) / Math.max(1, dn.length)) * Math.sqrt(ppy);
      Object.assign(out, { total_return: v[v.length - 1] / v[0] - 1, annualized_return: ann, annualized_volatility: vol,
        sharpe: div(ann - rf, vol), sortino: div(ann - rf, dvol), max_drawdown: mdd, current_drawdown: 1 - v[v.length - 1] / Math.max(...v),
        best_day: Math.max(...rets), worst_day: Math.min(...rets),
        return_30d: v.length > 30 ? v[v.length - 1] / v[v.length - 31] - 1 : null,
        return_90d: v.length > 90 ? v[v.length - 1] / v[v.length - 91] - 1 : null });
    }
    if (weights) {
      const w = Object.values(weights).map(x => Math.max(0, Number(x))), sum = w.reduce((a, b) => a + b, 0);
      if (sum > 0) { const hhi = w.reduce((a, x) => a + (x / sum) ** 2, 0); out.hhi = hhi; out.effective_assets = 1 / hhi; out.top_weight = Math.max(...w) / sum; }
    }
    return out;
  }

  const usd0 = (x) => '$' + Math.round(x).toLocaleString('en-US');
  const pct0 = (x) => (x * 100).toFixed(0) + '%';

  function buildInsights(snapshot, settings) {
    const s = { ...DEFAULTS, ...(settings || {}) };
    const positions = snapshot.positions || [], asOf = snapshot.as_of;
    const method = (snapshot.analytics && snapshot.analytics.basis_method) || 'HIFO';
    const missing = (snapshot.analytics && snapshot.analytics.missing_basis_count) || 0;
    const total = positions.reduce((a, p) => a + Number(p.value || 0), 0);
    const lots = enrichLots(positions, asOf, s);
    const harvest = harvestCandidates(lots, s, asOf);
    const hsum = harvestSummary(harvest, snapshot.realized, s);
    const takes = profitTakeCandidates(positions, lots, total, s, snapshot.price_history, method);
    const weights = {}; positions.forEach(p => weights[p.symbol] = Number(p.value || 0));
    const risk = riskMetrics(snapshot.history || [], weights);
    const items = [];
    for (const c of harvest.slice(0, 10)) items.push({ kind: 'harvest', priority: c.est_tax_savings >= 500 ? 1 : 2, symbol: c.symbol,
      amount_usd: c.loss, tax_effect: c.est_tax_savings, title: `Harvest ${c.symbol} loss of ${usd0(c.loss)}`,
      detail: `Lot bought ${c.purchased_at} (${c.term}-term) is down ${pct0(-c.gain_pct)}. Selling realizes a ${usd0(c.loss)} loss, worth about ${usd0(c.est_tax_savings)} in tax at ${pct0(c.tax_rate)}.` +
        (s.wash_sale_conservative ? ' Conservative mode: wait 31 days before re-buying.' : ' Crypto is not currently subject to the wash-sale rule, so you can re-buy immediately.') });
    for (const t of takes) {
      const why = t.reasons.join(', ').replace(/_/g, ' '), tax = t.sale ? t.sale.est_tax : 0;
      items.push({ kind: 'profit_take', priority: t.reasons.includes('concentration') ? 1 : 2, symbol: t.symbol, amount_usd: t.trim_value, tax_effect: -tax,
        title: `Trim ${t.symbol} by ${usd0(t.trim_value)} (${why})`,
        detail: `${t.symbol} is ${pct0(t.weight)} of the portfolio and up ${pct0(t.gain_pct)} on a ${usd0(t.basis)} basis. Selling ${Number(t.trim_units.toPrecision(4))} units via ${method} realizes about ${usd0(t.sale ? t.sale.realized_gain : 0)} gain, ~${usd0(tax)} tax.` });
      if (t.wait_for_long_term) { const w = t.wait_for_long_term;
        items.push({ kind: 'hold', priority: 1, symbol: t.symbol, amount_usd: w.gain_at_stake, tax_effect: w.est_tax_saved_by_waiting,
          title: `Hold ${t.symbol} ${w.max_days} more days before selling`,
          detail: `${w.lots} lot(s) with ${usd0(w.gain_at_stake)} of gain turn long-term within ${w.max_days} days, saving about ${usd0(w.est_tax_saved_by_waiting)} in tax.` }); }
    }
    if ((risk.top_weight || 0) > s.max_weight) { const top = Object.keys(weights).sort((a, b) => weights[b] - weights[a])[0];
      items.push({ kind: 'risk', priority: 2, symbol: top, amount_usd: null, tax_effect: null, title: `Concentration: ${top} is ${pct0(risk.top_weight)} of holdings`,
        detail: `Effective number of assets is ${(risk.effective_assets || 0).toFixed(1)}. Ceiling is ${pct0(s.max_weight)}.` }); }
    if ((risk.current_drawdown || 0) >= 0.10) items.push({ kind: 'risk', priority: 2, symbol: null, amount_usd: null, tax_effect: null,
      title: `Portfolio is ${pct0(risk.current_drawdown)} below its high`, detail: 'Drawdowns are when harvestable losses are largest; review the Tax tab.' });
    if (missing) items.push({ kind: 'basis', priority: 1, symbol: null, amount_usd: null, tax_effect: null, title: `${missing} transaction(s) missing cost basis in Awaken`,
      detail: 'Awaken assumes $0 cost for these, which overstates gains. Fix them in Awaken (import the source wallet, link the transfer, or set a receive price).' });
    items.sort((a, b) => (a.priority - b.priority) || ((b.tax_effect || 0) - (a.tax_effect || 0)));
    return { as_of: asOf, settings: s, basis_method: method,
      totals: { value: total, cost_basis: lots.reduce((a, l) => a + l.basis, 0), unrealized: lots.reduce((a, l) => a + l.gain, 0),
        unrealized_short: lots.filter(l => l.term === 'short').reduce((a, l) => a + l.gain, 0),
        unrealized_long: lots.filter(l => l.term === 'long').reduce((a, l) => a + l.gain, 0) },
      lots, harvest, harvest_summary: hsum, profit_take: takes, risk, items, missing_basis_count: missing };
  }

  global.PortfolioAnalytics = { DEFAULTS, lotTerm, enrichLots, harvestCandidates, harvestSummary, priceSignals, taxCostOfSale, profitTakeCandidates, riskMetrics, buildInsights };
})(typeof window !== 'undefined' ? window : globalThis);
if (typeof module !== 'undefined') module.exports = globalThis.PortfolioAnalytics;
