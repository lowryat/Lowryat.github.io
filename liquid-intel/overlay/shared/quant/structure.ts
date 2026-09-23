import { correlationMatrix, averageCorrelation } from "./linalg";
import { clamp, ewmaVolatility, mean, percentRank, robustZ, rsi, simpleMovingAverage, spearman, stdev } from "./stats";

/**
 * Market structure from daily closes. Every metric is computed from returns
 * or volatility-normalized distances (stationary quantities), never from raw
 * price or supply levels, so readings are comparable across assets and time.
 * The composite signal is validated walk-forward against realized forward
 * returns and the result is reported honestly, including "no edge".
 */

export type DailyPanel = {
  dates: string[];
  closes: Record<string, Array<number | null>>;
  volumes: Record<string, Array<number | null>>;
  stablecoinSupply: Array<number | null>;
  totalTvl: Array<number | null>;
  dexVolume: Array<number | null>;
  fearGreed: Array<number | null>;
};

export type SignalComponents = { trend: number; momentum: number; relative: number; participation: number };

export type AssetStructure = {
  symbol: string;
  price: number;
  observations: number;
  ret1d: number | null;
  ret7d: number | null;
  ret30d: number | null;
  ret90d: number | null;
  vol30: number | null;
  ewmaVol: number | null;
  volPercentile: number | null;
  dist50: number | null;
  dist200: number | null;
  goldenCross: boolean | null;
  rsi14: number | null;
  drawdown365: number | null;
  beta90: number | null;
  corr90: number | null;
  relStrength30: number | null;
  volumeZ: number | null;
  returnZ: number | null;
  components: SignalComponents;
  composite: number;
  label: "Strong uptrend" | "Uptrend" | "Neutral" | "Downtrend" | "Strong downtrend";
};

export type SignalValidation = {
  horizonDays: number;
  evaluations: number;
  meanIc: number | null;
  icTStat: number | null;
  hitRate: number | null;
  topMinusBottom: number | null;
  verdict: "predictive" | "weak" | "none" | "insufficient data";
  note: string;
};

export type Insight = {
  id: string;
  tone: "bull" | "bear" | "neutral" | "alert";
  title: string;
  detail: string;
};

export type MarketStructure = {
  asOf: string | null;
  assets: AssetStructure[];
  regime: {
    trend: "bull" | "bear" | "transition" | "unknown";
    volatility: "low" | "normal" | "high" | "unknown";
    label: string;
    btcVol30: number | null;
    btcVolPercentile: number | null;
  };
  breadth: { above50: number | null; above200: number | null; advancing7d: number | null };
  correlation: { average30: number | null; dispersion30: number | null };
  liquidity: {
    stablecoinSupply: number | null;
    stablecoinChange7d: number | null;
    stablecoinChange30d: number | null;
    stablecoinChange30dPct: number | null;
    stablecoinImpulseZ: number | null;
    tvlChange30dPct: number | null;
    dexVolumeRatio7v30: number | null;
    fearGreed: number | null;
    fearGreedChange7d: number | null;
    conditional: { condition: string; n: number; avgForward30: number; baseline30: number } | null;
  };
  validation: SignalValidation[];
  insights: Insight[];
};

const DAYS_PER_YEAR = 365;

function at(series: Array<number | null> | undefined, index: number): number | null {
  const value = series?.[index];
  return value != null && Number.isFinite(value) ? value : null;
}

/** Contiguous non-null closes ending at `end` (inclusive), oldest first. */
function trailing(series: Array<number | null>, end: number, maxLength: number): number[] {
  const out: number[] = [];
  for (let index = end; index >= 0 && out.length < maxLength; index -= 1) {
    const value = series[index];
    if (value == null || !(value > 0)) break;
    out.push(value);
  }
  return out.reverse();
}

function pctChange(series: Array<number | null>, end: number, lag: number): number | null {
  const now = at(series, end);
  const then = at(series, end - lag);
  return now != null && then != null && then !== 0 ? now / then - 1 : null;
}

function logReturnsOf(closes: number[]): number[] {
  const out: number[] = [];
  for (let index = 1; index < closes.length; index += 1) out.push(Math.log(closes[index] / closes[index - 1]));
  return out;
}

type RawFeatures = Omit<AssetStructure, "components" | "composite" | "label"> & { dailyVol: number | null; mom30: number | null; mom90: number | null };

function rawFeatures(symbol: string, panel: DailyPanel, end: number, btcReturns30: number | null, btcSeries: number[]): RawFeatures | null {
  const closes = trailing(panel.closes[symbol] ?? [], end, 400);
  if (closes.length < 35) return null;
  const price = closes[closes.length - 1];
  const returns = logReturnsOf(closes);
  const last30 = returns.slice(-30);
  const dailyVol = last30.length >= 20 ? stdev(last30) : null;
  const vol30 = dailyVol != null ? dailyVol * Math.sqrt(DAYS_PER_YEAR) : null;
  const ewma = returns.length >= 30 ? ewmaVolatility(returns.slice(-180)) * Math.sqrt(DAYS_PER_YEAR) : null;
  const rollingVols: number[] = [];
  for (let stop = 30; stop <= returns.length; stop += 5) rollingVols.push(stdev(returns.slice(stop - 30, stop)));
  const volPercentile = dailyVol != null && rollingVols.length >= 12 ? percentRank(rollingVols.slice(-73), dailyVol) : null;
  const sma50 = simpleMovingAverage(closes, 50);
  const sma200 = simpleMovingAverage(closes, 200);
  const ret = (lag: number) => (closes.length > lag ? price / closes[closes.length - 1 - lag] - 1 : null);
  const logRet = (lag: number) => (closes.length > lag ? Math.log(price / closes[closes.length - 1 - lag]) : null);
  const mom = (lag: number) => {
    const value = logRet(lag);
    return value != null && dailyVol ? value / (dailyVol * Math.sqrt(lag)) : null;
  };
  const window365 = closes.slice(-365);
  const peak = Math.max(...window365);
  // Beta and correlation versus BTC over the last 90 aligned daily returns.
  let beta90: number | null = null;
  let corr90: number | null = null;
  const own90 = returns.slice(-90);
  const btc90 = btcSeries.slice(-own90.length);
  if (own90.length >= 60 && btc90.length === own90.length) {
    const btcMean = mean(btc90);
    const ownMean = mean(own90);
    let covariance = 0;
    let btcVar = 0;
    let ownVar = 0;
    for (let t = 0; t < own90.length; t += 1) {
      covariance += (own90[t] - ownMean) * (btc90[t] - btcMean);
      btcVar += (btc90[t] - btcMean) ** 2;
      ownVar += (own90[t] - ownMean) ** 2;
    }
    beta90 = btcVar > 0 ? covariance / btcVar : null;
    corr90 = btcVar > 0 && ownVar > 0 ? covariance / Math.sqrt(btcVar * ownVar) : null;
  }
  const volumes = trailing(panel.volumes[symbol] ?? [], end, 31);
  let volumeZ: number | null = null;
  if (volumes.length >= 21) {
    const logs = volumes.map((value) => Math.log(value));
    const history = logs.slice(0, -1);
    const sd = stdev(history);
    volumeZ = sd > 0 ? (logs[logs.length - 1] - mean(history)) / sd : null;
  }
  const lastReturn = returns[returns.length - 1];
  const returnZ = returns.length >= 60 ? robustZ(lastReturn, returns.slice(-91, -1)) : null;
  const ret30 = ret(30);
  return {
    symbol,
    price,
    observations: closes.length,
    ret1d: ret(1),
    ret7d: ret(7),
    ret30d: ret30,
    ret90d: ret(90),
    vol30,
    ewmaVol: ewma,
    volPercentile,
    dist50: sma50 ? price / sma50 - 1 : null,
    dist200: sma200 ? price / sma200 - 1 : null,
    goldenCross: sma50 && sma200 ? sma50 > sma200 : null,
    rsi14: rsi(closes, 14),
    drawdown365: peak > 0 ? price / peak - 1 : null,
    beta90,
    corr90,
    relStrength30: ret30 != null && btcReturns30 != null ? ret30 - btcReturns30 : null,
    volumeZ,
    returnZ,
    dailyVol,
    mom30: mom(30),
    mom90: mom(90),
  };
}

function labelFor(composite: number): AssetStructure["label"] {
  if (composite >= 40) return "Strong uptrend";
  if (composite >= 15) return "Uptrend";
  if (composite > -15) return "Neutral";
  if (composite > -40) return "Downtrend";
  return "Strong downtrend";
}

/** Composite signal for every asset with enough history at index `end`. */
export function scoreAssets(panel: DailyPanel, end: number, benchmark = "BTC"): AssetStructure[] {
  const btcCloses = trailing(panel.closes[benchmark] ?? [], end, 400);
  const btcReturns = logReturnsOf(btcCloses);
  const btcRet30 = btcCloses.length > 30 ? btcCloses[btcCloses.length - 1] / btcCloses[btcCloses.length - 31] - 1 : null;
  const features = Object.keys(panel.closes)
    .map((symbol) => rawFeatures(symbol, panel, end, btcRet30, btcReturns))
    .filter((item): item is RawFeatures => item != null);
  const relValues = features.map((item) => item.relStrength30).filter((value): value is number => value != null);
  const relMean = relValues.length ? mean(relValues) : 0;
  const relSd = relValues.length > 2 ? stdev(relValues) : 0;
  return features.map((item) => {
    const vol = item.dailyVol;
    const trendParts: number[] = [];
    if (item.dist50 != null && vol) trendParts.push(item.dist50 / (vol * Math.sqrt(50)));
    if (item.dist200 != null && vol) trendParts.push(item.dist200 / (vol * Math.sqrt(200)));
    const momentumParts = [item.mom30, item.mom90].filter((value): value is number => value != null);
    const components: SignalComponents = {
      trend: trendParts.length ? Math.tanh(mean(trendParts)) : 0,
      momentum: momentumParts.length ? Math.tanh(mean(momentumParts) / 1.5) : 0,
      relative: item.relStrength30 != null && relSd > 0 ? Math.tanh((item.relStrength30 - relMean) / relSd / 1.5) : 0,
      participation: item.volumeZ != null && item.ret7d != null ? Math.tanh(item.volumeZ / 2) * Math.sign(item.ret7d) : 0,
    };
    const composite = clamp(100 * (0.35 * components.trend + 0.35 * components.momentum + 0.2 * components.relative + 0.1 * components.participation), -100, 100);
    const { dailyVol: _dailyVol, mom30: _mom30, mom90: _mom90, ...rest } = item;
    return { ...rest, components, composite, label: labelFor(composite) };
  });
}

/**
 * Walk-forward check of the composite: at non-overlapping dates, rank assets by
 * the score computed only from data available then, and correlate those ranks
 * with realized forward returns (Spearman information coefficient).
 */
export function validateSignal(panel: DailyPanel, horizon: number, benchmark = "BTC"): SignalValidation {
  const last = panel.dates.length - 1;
  const ics: number[] = [];
  const spreads: number[] = [];
  for (let end = 210; end + horizon <= last; end += horizon) {
    const scored = scoreAssets(panel, end, benchmark);
    const pairs = scored.flatMap((asset) => {
      const now = at(panel.closes[asset.symbol], end);
      const future = at(panel.closes[asset.symbol], end + horizon);
      return now != null && future != null ? [{ score: asset.composite, forward: Math.log(future / now) }] : [];
    });
    if (pairs.length < 6) continue;
    const ic = spearman(pairs.map((pair) => pair.score), pairs.map((pair) => pair.forward));
    if (ic == null) continue;
    ics.push(ic);
    const sorted = [...pairs].sort((a, b) => b.score - a.score);
    const third = Math.max(1, Math.floor(sorted.length / 3));
    spreads.push(mean(sorted.slice(0, third).map((pair) => pair.forward)) - mean(sorted.slice(-third).map((pair) => pair.forward)));
  }
  if (ics.length < 8) {
    return { horizonDays: horizon, evaluations: ics.length, meanIc: null, icTStat: null, hitRate: null, topMinusBottom: null, verdict: "insufficient data", note: "Needs roughly a year of daily history across the tracked assets." };
  }
  const meanIc = mean(ics);
  const sd = stdev(ics);
  const tStat = sd > 0 ? meanIc / (sd / Math.sqrt(ics.length)) : 0;
  const hitRate = ics.filter((value) => value > 0).length / ics.length;
  const verdict = meanIc > 0.05 && tStat > 2 ? "predictive" : meanIc > 0.02 && tStat > 1 ? "weak" : "none";
  const note = verdict === "predictive"
    ? "Higher scores have been followed by higher returns across the test windows."
    : verdict === "weak"
      ? "A small positive relationship that is not statistically reliable; treat the score as context."
      : "No reliable forward edge in this sample; use the score to describe trend, not to predict.";
  return { horizonDays: horizon, evaluations: ics.length, meanIc, icTStat: tStat, hitRate, topMinusBottom: mean(spreads), verdict, note };
}

function stablecoinImpulse(panel: DailyPanel, end: number) {
  const supply = panel.stablecoinSupply;
  const changes: number[] = [];
  for (let index = Math.max(30, end - 365); index <= end; index += 1) {
    const change = pctChange(supply, index, 30);
    if (change != null) changes.push(change);
  }
  const current = pctChange(supply, end, 30);
  if (current == null || changes.length < 60) return { current, z: null };
  const sd = stdev(changes);
  return { current, z: sd > 0 ? (current - mean(changes)) / sd : null };
}

/** Average forward 30d BTC return when the stablecoin impulse was strong, versus all days. */
function conditionalEvidence(panel: DailyPanel, benchmark: string) {
  const btc = panel.closes[benchmark] ?? [];
  const forward: number[] = [];
  const conditioned: number[] = [];
  for (let end = 60; end + 30 < panel.dates.length; end += 1) {
    const now = at(btc, end);
    const future = at(btc, end + 30);
    if (now == null || future == null) continue;
    const change = future / now - 1;
    forward.push(change);
    const window: number[] = [];
    for (let index = Math.max(30, end - 365); index <= end; index += 1) {
      const value = pctChange(panel.stablecoinSupply, index, 30);
      if (value != null) window.push(value);
    }
    const current = pctChange(panel.stablecoinSupply, end, 30);
    if (current == null || window.length < 60) continue;
    const sd = stdev(window);
    if (sd > 0 && (current - mean(window)) / sd > 1) conditioned.push(change);
  }
  if (conditioned.length < 20 || forward.length < 60) return null;
  return { condition: "30-day stablecoin growth more than 1 standard deviation above its 1-year norm", n: conditioned.length, avgForward30: mean(conditioned), baseline30: mean(forward) };
}

export function computeMarketStructure(panel: DailyPanel, benchmark = "BTC"): MarketStructure {
  const end = panel.dates.length - 1;
  const assets = end >= 0 ? scoreAssets(panel, end, benchmark).sort((a, b) => b.composite - a.composite) : [];
  const btc = assets.find((asset) => asset.symbol === benchmark) ?? null;
  const trend: MarketStructure["regime"]["trend"] = !btc || btc.dist200 == null || btc.goldenCross == null
    ? "unknown"
    : btc.dist200 > 0 && btc.goldenCross ? "bull" : btc.dist200 < 0 && !btc.goldenCross ? "bear" : "transition";
  const volatility: MarketStructure["regime"]["volatility"] = btc?.volPercentile == null
    ? "unknown"
    : btc.volPercentile > 0.75 ? "high" : btc.volPercentile < 0.25 ? "low" : "normal";
  const trendLabel = { bull: "Bull trend", bear: "Bear trend", transition: "Transition", unknown: "Trend unknown" }[trend];
  const volLabel = { low: "low volatility", normal: "normal volatility", high: "high volatility", unknown: "volatility unknown" }[volatility];
  const withDist50 = assets.filter((asset) => asset.dist50 != null);
  const withDist200 = assets.filter((asset) => asset.dist200 != null);
  const with7d = assets.filter((asset) => asset.ret7d != null);
  const breadth = {
    above50: withDist50.length ? withDist50.filter((asset) => asset.dist50! > 0).length / withDist50.length : null,
    above200: withDist200.length ? withDist200.filter((asset) => asset.dist200! > 0).length / withDist200.length : null,
    advancing7d: with7d.length ? with7d.filter((asset) => asset.ret7d! > 0).length / with7d.length : null,
  };
  const recentReturns = Object.keys(panel.closes)
    .map((symbol) => logReturnsOf(trailing(panel.closes[symbol], end, 31)))
    .filter((series) => series.length === 30);
  const average30 = recentReturns.length >= 5 ? averageCorrelation(correlationMatrix(recentReturns)) : null;
  const month = assets.map((asset) => asset.ret30d).filter((value): value is number => value != null);
  const impulse = end >= 0 ? stablecoinImpulse(panel, end) : { current: null, z: null };
  const supplyNow = at(panel.stablecoinSupply, end);
  const supply7 = at(panel.stablecoinSupply, end - 7);
  const supply30 = at(panel.stablecoinSupply, end - 30);
  const dexRecent = panel.dexVolume.slice(Math.max(0, end - 6), end + 1).filter((value): value is number => value != null);
  const dexMonth = panel.dexVolume.slice(Math.max(0, end - 29), end + 1).filter((value): value is number => value != null);
  const fear = at(panel.fearGreed, end);
  const fear7 = at(panel.fearGreed, end - 7);
  const liquidity: MarketStructure["liquidity"] = {
    stablecoinSupply: supplyNow,
    stablecoinChange7d: supplyNow != null && supply7 != null ? supplyNow - supply7 : null,
    stablecoinChange30d: supplyNow != null && supply30 != null ? supplyNow - supply30 : null,
    stablecoinChange30dPct: impulse.current,
    stablecoinImpulseZ: impulse.z,
    tvlChange30dPct: end >= 0 ? pctChange(panel.totalTvl, end, 30) : null,
    dexVolumeRatio7v30: dexRecent.length >= 5 && dexMonth.length >= 20 ? mean(dexRecent) / mean(dexMonth) : null,
    fearGreed: fear,
    fearGreedChange7d: fear != null && fear7 != null ? fear - fear7 : null,
    conditional: conditionalEvidence(panel, benchmark),
  };
  const validation = [validateSignal(panel, 7, benchmark), validateSignal(panel, 30, benchmark)];
  const structure: MarketStructure = {
    asOf: end >= 0 ? panel.dates[end] : null,
    assets,
    regime: { trend, volatility, label: `${trendLabel}, ${volLabel}`, btcVol30: btc?.vol30 ?? null, btcVolPercentile: btc?.volPercentile ?? null },
    breadth,
    correlation: { average30, dispersion30: month.length > 2 ? stdev(month) : null },
    liquidity,
    validation,
    insights: [],
  };
  structure.insights = buildInsights(structure);
  return structure;
}

const pct = (value: number, digits = 1) => `${value >= 0 ? "+" : ""}${(value * 100).toFixed(digits)}%`;

export function buildInsights(structure: MarketStructure): Insight[] {
  const insights: Insight[] = [];
  const { regime, breadth, correlation, liquidity, assets, validation } = structure;
  if (regime.trend !== "unknown") {
    insights.push({
      id: "regime",
      tone: regime.trend === "bull" ? "bull" : regime.trend === "bear" ? "bear" : "neutral",
      title: `Regime: ${regime.label}`,
      detail: regime.btcVolPercentile != null
        ? `BTC 30-day volatility is ${((regime.btcVol30 ?? 0) * 100).toFixed(0)}% annualized, at the ${(regime.btcVolPercentile * 100).toFixed(0)}th percentile of the past year.`
        : "Trend classified from BTC versus its 50- and 200-day averages.",
    });
  }
  if (liquidity.stablecoinImpulseZ != null && Math.abs(liquidity.stablecoinImpulseZ) >= 1 && liquidity.stablecoinChange30dPct != null) {
    const expanding = liquidity.stablecoinImpulseZ > 0;
    const evidence = liquidity.conditional && expanding
      ? ` In this history, similar expansions were followed by an average BTC 30-day return of ${pct(liquidity.conditional.avgForward30)} versus ${pct(liquidity.conditional.baseline30)} on all days (${liquidity.conditional.n} overlapping days, so treat as indicative).`
      : "";
    // Do not color an expansion bullish when this history says it was followed by weaker returns.
    const contradicted = expanding && liquidity.conditional != null && liquidity.conditional.avgForward30 < liquidity.conditional.baseline30;
    insights.push({
      id: "stablecoin-impulse",
      tone: contradicted ? "neutral" : expanding ? "bull" : "bear",
      title: `Stablecoin supply ${expanding ? "expanding" : "contracting"} ${pct(liquidity.stablecoinChange30dPct)} in 30 days`,
      detail: `That is ${Math.abs(liquidity.stablecoinImpulseZ).toFixed(1)} standard deviations ${expanding ? "above" : "below"} the 1-year norm for 30-day changes.${evidence}`,
    });
  }
  if (breadth.above50 != null && (breadth.above50 >= 0.7 || breadth.above50 <= 0.3)) {
    insights.push({
      id: "breadth",
      tone: breadth.above50 >= 0.7 ? "bull" : "bear",
      title: `${Math.round(breadth.above50 * 100)}% of tracked assets are above their 50-day average`,
      detail: breadth.above50 >= 0.7 ? "Participation is broad; the move is not carried by a single asset." : "Weakness is broad-based; few assets hold their medium-term trend.",
    });
  }
  if (correlation.average30 != null && correlation.average30 >= 0.7) {
    insights.push({
      id: "correlation",
      tone: "alert",
      title: `Average 30-day correlation is ${correlation.average30.toFixed(2)}`,
      detail: "Assets are moving together, so holding more coins adds little diversification. Size risk as one position.",
    });
  }
  const leaders = assets.filter((asset) => asset.composite >= 40).slice(0, 3);
  if (leaders.length) {
    insights.push({ id: "leaders", tone: "bull", title: `Strongest trends: ${leaders.map((asset) => asset.symbol).join(", ")}`, detail: leaders.map((asset) => `${asset.symbol} score ${asset.composite.toFixed(0)}${asset.ret30d != null ? `, ${pct(asset.ret30d)} 30d` : ""}`).join("; ") + "." });
  }
  const laggards = assets.filter((asset) => asset.composite <= -40).slice(-3);
  if (laggards.length) {
    insights.push({ id: "laggards", tone: "bear", title: `Weakest trends: ${laggards.map((asset) => asset.symbol).join(", ")}`, detail: laggards.map((asset) => `${asset.symbol} score ${asset.composite.toFixed(0)}${asset.drawdown365 != null ? `, ${pct(asset.drawdown365, 0)} from 1-year high` : ""}`).join("; ") + "." });
  }
  const anomalies = assets.filter((asset) => asset.returnZ != null && Math.abs(asset.returnZ) >= 3 && (asset.volumeZ ?? 0) >= 2);
  for (const asset of anomalies.slice(0, 3)) {
    insights.push({
      id: `anomaly-${asset.symbol}`,
      tone: "alert",
      title: `${asset.symbol}: unusual move on heavy volume`,
      detail: `Latest daily return is ${asset.returnZ!.toFixed(1)} robust standard deviations from its 90-day norm with volume ${asset.volumeZ!.toFixed(1)} standard deviations above average.`,
    });
  }
  const weekly = validation.find((item) => item.horizonDays === 7);
  if (weekly && weekly.verdict !== "insufficient data" && weekly.meanIc != null) {
    insights.push({
      id: "signal-quality",
      tone: "neutral",
      title: `Signal check: ${weekly.verdict === "predictive" ? "predictive" : weekly.verdict === "weak" ? "weak edge" : "no reliable edge"} at 7 days`,
      detail: `Mean rank correlation with next-week returns ${weekly.meanIc.toFixed(3)} (t=${(weekly.icTStat ?? 0).toFixed(1)}, ${weekly.evaluations} windows). ${weekly.note}`,
    });
  }
  return insights;
}
