import { Rng } from "./rng";
import { averageCorrelation, correlationMatrix, robustCholesky, shrinkCorrelation, stressCorrelation, type Matrix } from "./linalg";
import { chiSquare1PValue, clamp, ewmaVolatility, mean, ols, quantileSorted, stdev } from "./stats";

/**
 * Portfolio risk engine: correlated, fat-tailed Monte Carlo, confidence
 * intervals, VaR/CVaR, probability-weighted scenarios, strategy comparison,
 * one-at-a-time sensitivity (tornado), two-variable data tables, and a Kupiec
 * backtest of the VaR model on the portfolio's own history.
 *
 * Model. Each asset's horizon log return is
 *   X_i = m_i * H + s_i * k * sqrt(H) * (L z)_i
 * where L is the Cholesky factor of a shrunk (optionally stressed) correlation
 * matrix, z ~ N(0, I), s_i is the EWMA (RiskMetrics, lambda 0.94) daily
 * volatility times a volatility multiplier, and k is a per-path volatility
 * regime drawn from a scaled inverse chi-square (a multivariate Student-t at
 * the path level, capped at 3x). Path-level regimes keep horizon tails fat and
 * make every asset fall together in the bad regimes, which is what crypto
 * drawdowns look like; independent daily t-shocks would average away by day 30.
 */

export type RiskInputs = {
  symbols: string[];
  dates: string[];
  /** Aligned daily log returns, one array per symbol, oldest first. */
  returns: number[][];
  /** Latest close per symbol. */
  prices: number[];
};

export type RiskModel = {
  symbols: string[];
  observations: number;
  benchmarkIndex: number;
  meanDaily: number[];
  volDaily: number[];
  sampleVolDaily: number[];
  correlation: Matrix;
  averageCorrelation: number;
  beta: number[];
  prices: number[];
  benchmarkReturns: number[];
  returns: number[][];
};

export type RiskParams = {
  /** Fraction of portfolio value in each model asset; the remainder is cash. */
  weights: number[];
  horizonDays: number;
  /** "neutral" = no assumed edge (zero expected return); "historical" = shrunk sample drift. */
  driftMode: "neutral" | "historical";
  historicalShrink: number;
  /** When set, the benchmark's median horizon return; other assets follow via beta. */
  btcMove: number | null;
  /** Multiplier on non-benchmark betas when propagating btcMove. */
  altBeta: number;
  /** Extra horizon return for non-benchmark assets (idiosyncratic drift). */
  altDrift: number;
  volMultiplier: number;
  /** 0..1 blend of the correlation matrix toward a 0.9 crisis matrix. */
  corrStress: number;
  /** Student-t degrees of freedom for the volatility regime; >= 200 means Gaussian. */
  tailDf: number;
  /** Scales every weight (1 = as entered, 1.5 = 50% more exposure financed by cash). */
  exposure: number;
  paths: number;
  seed: number;
};

export const DEFAULT_RISK_PARAMS: Omit<RiskParams, "weights"> = {
  horizonDays: 30,
  driftMode: "neutral",
  historicalShrink: 0.5,
  btcMove: null,
  altBeta: 1,
  altDrift: 0,
  volMultiplier: 1,
  corrStress: 0,
  tailDf: 4,
  exposure: 1,
  paths: 5000,
  seed: 20260923,
};

const REGIME_CAP = 3;
const GAUSSIAN_DF = 200;

export function buildRiskModel(
  inputs: RiskInputs,
  options: { lookbackDays?: number; correlationDays?: number; ewmaLambda?: number; shrinkage?: number; benchmark?: string } = {},
): RiskModel {
  const lookback = options.lookbackDays ?? 365;
  const correlationDays = options.correlationDays ?? 180;
  const returns = inputs.returns.map((series) => series.slice(-lookback));
  const benchmarkIndex = Math.max(0, inputs.symbols.indexOf(options.benchmark ?? "BTC"));
  const correlationWindow = returns.map((series) => series.slice(-correlationDays));
  const correlation = shrinkCorrelation(correlationMatrix(correlationWindow), options.shrinkage ?? 0.15);
  const benchmark = correlationWindow[benchmarkIndex] ?? [];
  const benchmarkMean = mean(benchmark);
  const benchmarkVar = benchmark.reduce((sum, value) => sum + (value - benchmarkMean) ** 2, 0);
  const beta = correlationWindow.map((series) => {
    if (!benchmarkVar) return 1;
    const seriesMean = mean(series);
    let covariance = 0;
    for (let t = 0; t < Math.min(series.length, benchmark.length); t += 1) {
      covariance += (series[t] - seriesMean) * (benchmark[t] - benchmarkMean);
    }
    return covariance / benchmarkVar;
  });
  return {
    symbols: [...inputs.symbols],
    observations: returns[0]?.length ?? 0,
    benchmarkIndex,
    meanDaily: returns.map((series) => mean(series)),
    volDaily: returns.map((series) => ewmaVolatility(series, options.ewmaLambda ?? 0.94)),
    sampleVolDaily: returns.map((series) => stdev(series)),
    correlation,
    averageCorrelation: averageCorrelation(correlation),
    beta,
    prices: [...inputs.prices],
    benchmarkReturns: returns[benchmarkIndex] ?? [],
    returns,
  };
}

export function effectiveWeights(params: Pick<RiskParams, "weights" | "exposure">): { weights: number[]; cash: number } {
  const weights = params.weights.map((weight) => (Number.isFinite(weight) ? weight : 0) * params.exposure);
  return { weights, cash: 1 - weights.reduce((sum, weight) => sum + weight, 0) };
}

/** Daily drift and volatility per asset under the given assumptions. */
export function assetDynamics(model: RiskModel, params: RiskParams): { drift: number[]; vol: number[] } {
  const horizon = Math.max(1, params.horizonDays);
  const vol = model.volDaily.map((value) => (Number.isFinite(value) ? value : 0.03) * params.volMultiplier);
  const altLog = Math.log(Math.max(1e-6, 1 + params.altDrift)) / horizon;
  let drift: number[];
  if (params.btcMove != null) {
    const benchmarkLog = Math.log(Math.max(1e-6, 1 + params.btcMove));
    drift = model.symbols.map((_, index) => index === model.benchmarkIndex
      ? benchmarkLog / horizon
      : (model.beta[index] * params.altBeta * benchmarkLog) / horizon + altLog);
  } else if (params.driftMode === "historical") {
    drift = model.meanDaily.map((value, index) =>
      clamp((Number.isFinite(value) ? value : 0) * params.historicalShrink, -0.004, 0.004) + (index === model.benchmarkIndex ? 0 : altLog));
  } else {
    // Zero expected simple return: the log drift offsets the volatility convexity.
    drift = vol.map((value, index) => -0.5 * value * value + (index === model.benchmarkIndex ? 0 : altLog));
  }
  return { drift, vol };
}

/** Median-path (deterministic) portfolio return under the assumptions. */
export function centralReturn(model: RiskModel, params: RiskParams): number {
  const { drift } = assetDynamics(model, params);
  const { weights, cash } = effectiveWeights(params);
  let value = cash;
  for (let index = 0; index < weights.length; index += 1) value += weights[index] * Math.exp(drift[index] * params.horizonDays);
  return value - 1;
}

/** Common random numbers: identical shocks reused across every parameter set. */
export type ShockSet = {
  paths: number;
  assets: number;
  normals: Float64Array;
  regimeUniformSeed: number;
  regimes: Map<number, Float64Array>;
};

export function drawShocks(assets: number, paths: number, seed: number): ShockSet {
  const rng = new Rng(seed);
  const normals = new Float64Array(paths * assets);
  for (let index = 0; index < normals.length; index += 1) normals[index] = rng.normal();
  return { paths, assets, normals, regimeUniformSeed: seed ^ 0x5bd1e995, regimes: new Map() };
}

function regimeScales(shocks: ShockSet, degreesOfFreedom: number): Float64Array {
  const df = Math.round(degreesOfFreedom * 10) / 10;
  const cached = shocks.regimes.get(df);
  if (cached) return cached;
  const scales = new Float64Array(shocks.paths);
  if (df >= GAUSSIAN_DF) scales.fill(1);
  else {
    const rng = new Rng(shocks.regimeUniformSeed);
    const nu = Math.max(2.5, df);
    for (let path = 0; path < shocks.paths; path += 1) {
      scales[path] = Math.min(REGIME_CAP, Math.sqrt((nu - 2) / Math.max(1e-9, rng.chiSquare(nu))));
    }
  }
  shocks.regimes.set(df, scales);
  return scales;
}

/** Simulated horizon returns of the portfolio (fraction, e.g. -0.12 = -12%). */
export function simulatePortfolioReturns(model: RiskModel, params: RiskParams, shocks?: ShockSet): Float64Array {
  const assets = model.symbols.length;
  const paths = shocks?.paths ?? params.paths;
  const set = shocks ?? drawShocks(assets, paths, params.seed);
  const { drift, vol } = assetDynamics(model, params);
  const { weights, cash } = effectiveWeights(params);
  const factor = robustCholesky(stressCorrelation(model.correlation, params.corrStress)).factor;
  const scales = regimeScales(set, params.tailDf);
  const horizon = Math.max(1, params.horizonDays);
  const sqrtH = Math.sqrt(horizon);
  const result = new Float64Array(paths);
  const correlated = new Float64Array(assets);
  for (let path = 0; path < paths; path += 1) {
    const offset = path * assets;
    for (let i = 0; i < assets; i += 1) {
      let sum = 0;
      const row = factor[i];
      for (let j = 0; j <= i; j += 1) sum += row[j] * set.normals[offset + j];
      correlated[i] = sum;
    }
    const scale = scales[path];
    let value = cash;
    for (let i = 0; i < assets; i += 1) {
      if (weights[i] === 0) continue;
      value += weights[i] * Math.exp(drift[i] * horizon + vol[i] * scale * sqrtH * correlated[i]);
    }
    result[path] = value - 1;
  }
  return result;
}

export type DistributionSummary = {
  n: number;
  mean: number;
  stdev: number;
  median: number;
  percentiles: Record<"p1" | "p2_5" | "p5" | "p10" | "p25" | "p50" | "p75" | "p90" | "p95" | "p97_5" | "p99", number>;
  ci90: [number, number];
  ci95: [number, number];
  /** Loss at the 5th / 1st percentile, as a positive fraction of portfolio value. */
  var95: number;
  var99: number;
  /** Average loss beyond VaR (expected shortfall), positive fraction. */
  cvar95: number;
  cvar99: number;
  probLoss: number;
  probLossOver10: number;
  probGainOver10: number;
  /** Monte Carlo standard error of the mean. */
  standardError: number;
};

export function summarize(values: ArrayLike<number>): DistributionSummary {
  const sorted = Float64Array.from(values as ArrayLike<number>).sort();
  const n = sorted.length;
  let sum = 0;
  for (let index = 0; index < n; index += 1) sum += sorted[index];
  const average = n ? sum / n : NaN;
  let squared = 0;
  let losses = 0;
  let bigLosses = 0;
  let bigGains = 0;
  for (let index = 0; index < n; index += 1) {
    const value = sorted[index];
    squared += (value - average) ** 2;
    if (value < 0) losses += 1;
    if (value < -0.1) bigLosses += 1;
    if (value > 0.1) bigGains += 1;
  }
  const sd = n > 1 ? Math.sqrt(squared / (n - 1)) : 0;
  const q = (p: number) => quantileSorted(sorted, p);
  const tailMean = (p: number) => {
    const count = Math.max(1, Math.floor(n * p));
    let tail = 0;
    for (let index = 0; index < count; index += 1) tail += sorted[index];
    return tail / count;
  };
  const percentiles = {
    p1: q(0.01), p2_5: q(0.025), p5: q(0.05), p10: q(0.1), p25: q(0.25), p50: q(0.5),
    p75: q(0.75), p90: q(0.9), p95: q(0.95), p97_5: q(0.975), p99: q(0.99),
  };
  return {
    n,
    mean: average,
    stdev: sd,
    median: percentiles.p50,
    percentiles,
    ci90: [percentiles.p5, percentiles.p95],
    ci95: [percentiles.p2_5, percentiles.p97_5],
    var95: Math.max(0, -percentiles.p5),
    var99: Math.max(0, -percentiles.p1),
    cvar95: Math.max(0, -tailMean(0.05)),
    cvar99: Math.max(0, -tailMean(0.01)),
    probLoss: n ? losses / n : NaN,
    probLossOver10: n ? bigLosses / n : NaN,
    probGainOver10: n ? bigGains / n : NaN,
    standardError: n ? sd / Math.sqrt(n) : NaN,
  };
}

export function histogram(values: ArrayLike<number>, bins = 40): Array<{ from: number; to: number; mid: number; count: number; share: number }> {
  const sorted = Float64Array.from(values as ArrayLike<number>).sort();
  if (!sorted.length) return [];
  const low = quantileSorted(sorted, 0.005);
  const high = quantileSorted(sorted, 0.995);
  const width = (high - low) / bins || 1e-6;
  const counts = new Array<number>(bins).fill(0);
  for (let index = 0; index < sorted.length; index += 1) {
    const bucket = Math.min(bins - 1, Math.max(0, Math.floor((sorted[index] - low) / width)));
    counts[bucket] += 1;
  }
  return counts.map((count, index) => ({
    from: low + index * width,
    to: low + (index + 1) * width,
    mid: low + (index + 0.5) * width,
    count,
    share: count / sorted.length,
  }));
}

export type MonteCarloResult = {
  summary: DistributionSummary;
  histogram: ReturnType<typeof histogram>;
  centralReturn: number;
  params: RiskParams;
};

export function runMonteCarlo(model: RiskModel, params: RiskParams): MonteCarloResult {
  const returns = simulatePortfolioReturns(model, params);
  return { summary: summarize(returns), histogram: histogram(returns), centralReturn: centralReturn(model, params), params };
}

export type PathBands = {
  day: number;
  p5: number;
  p25: number;
  p50: number;
  p75: number;
  p95: number;
};

export type PathSimulation = {
  bands: PathBands[];
  maxDrawdown: { median: number; p95: number; probOver20: number };
  paths: number;
};

/** Daily paths for the fan chart and the drawdown distribution (portfolio value, start = 1). */
export function simulatePaths(model: RiskModel, params: RiskParams, paths = 1000, maxPoints = 60): PathSimulation {
  const assets = model.symbols.length;
  const horizon = Math.max(1, Math.round(params.horizonDays));
  const rng = new Rng(params.seed + 101);
  const regimeRng = new Rng(params.seed + 202);
  const { drift, vol } = assetDynamics(model, params);
  const { weights, cash } = effectiveWeights(params);
  const factor = robustCholesky(stressCorrelation(model.correlation, params.corrStress)).factor;
  const step = Math.max(1, Math.ceil(horizon / maxPoints));
  const sampleDays: number[] = [];
  for (let day = 0; day <= horizon; day += step) sampleDays.push(day);
  if (sampleDays[sampleDays.length - 1] !== horizon) sampleDays.push(horizon);
  const values: Float64Array[] = sampleDays.map(() => new Float64Array(paths));
  const drawdowns = new Float64Array(paths);
  const logLevel = new Float64Array(assets);
  const z = new Float64Array(assets);
  for (let path = 0; path < paths; path += 1) {
    logLevel.fill(0);
    const nu = params.tailDf;
    const scale = nu >= GAUSSIAN_DF ? 1 : Math.min(REGIME_CAP, Math.sqrt((Math.max(2.5, nu) - 2) / Math.max(1e-9, regimeRng.chiSquare(Math.max(2.5, nu)))));
    let peak = 1;
    let worst = 0;
    let sampleIndex = 0;
    values[sampleIndex++][path] = 1;
    for (let day = 1; day <= horizon; day += 1) {
      for (let j = 0; j < assets; j += 1) z[j] = rng.normal();
      let value = cash;
      for (let i = 0; i < assets; i += 1) {
        let shock = 0;
        const row = factor[i];
        for (let j = 0; j <= i; j += 1) shock += row[j] * z[j];
        logLevel[i] += drift[i] + vol[i] * scale * shock;
        if (weights[i] !== 0) value += weights[i] * Math.exp(logLevel[i]);
      }
      if (value > peak) peak = value;
      if (peak > 0) worst = Math.max(worst, 1 - value / peak);
      if (sampleIndex < sampleDays.length && sampleDays[sampleIndex] === day) values[sampleIndex++][path] = value;
    }
    drawdowns[path] = worst;
  }
  const bands = sampleDays.map((day, index) => {
    const sorted = values[index].sort();
    return {
      day,
      p5: quantileSorted(sorted, 0.05) - 1,
      p25: quantileSorted(sorted, 0.25) - 1,
      p50: quantileSorted(sorted, 0.5) - 1,
      p75: quantileSorted(sorted, 0.75) - 1,
      p95: quantileSorted(sorted, 0.95) - 1,
    };
  });
  const sortedDrawdowns = drawdowns.sort();
  let over20 = 0;
  for (let index = 0; index < sortedDrawdowns.length; index += 1) if (sortedDrawdowns[index] > 0.2) over20 += 1;
  return {
    bands,
    maxDrawdown: { median: quantileSorted(sortedDrawdowns, 0.5), p95: quantileSorted(sortedDrawdowns, 0.95), probOver20: over20 / paths },
    paths,
  };
}

// ---------------------------------------------------------------------------
// Scenario planning
// ---------------------------------------------------------------------------

export type Scenario = {
  id: string;
  name: string;
  description: string;
  probability: number;
  btcMove: number;
  altBeta: number;
  altDrift: number;
  volMultiplier: number;
  corrStress: number;
};

/** Rolling H-day log returns of the benchmark (overlapping windows). */
export function rollingHorizonReturns(dailyLogReturns: readonly number[], horizon: number): number[] {
  const result: number[] = [];
  let window = 0;
  for (let index = 0; index < dailyLogReturns.length; index += 1) {
    window += dailyLogReturns[index];
    if (index >= horizon) window -= dailyLogReturns[index - horizon];
    if (index >= horizon - 1) result.push(window);
  }
  return result;
}

/**
 * Four economic environments shaped by the benchmark's own history over this
 * horizon, with probabilities tilted by the current trend regime.
 *
 * With `center`, the historical distribution keeps its shape and spread but is
 * re-centered so the base case equals `center` (the same median benchmark move
 * the Monte Carlo assumes). Without it, raw historical percentiles are used,
 * which silently carry the lookback window's trend into every scenario.
 */
export function calibrateScenarios(
  model: RiskModel,
  horizonDays: number,
  regime: "bull" | "bear" | "transition" = "transition",
  center?: number,
): Scenario[] {
  const history = rollingHorizonReturns(model.benchmarkReturns, horizonDays).sort((a, b) => a - b);
  const scale = Math.sqrt(horizonDays / 30);
  const fallback = (p: number) => ({ 0.8: 0.12, 0.5: 0.0, 0.2: -0.12, 0.03: -0.3 } as Record<number, number>)[p] * scale;
  const median = history.length >= 60 ? quantileSorted(history, 0.5) : 0;
  const anchor = center != null && Number.isFinite(center) ? Math.log(Math.max(1e-6, 1 + center)) : null;
  const move = (p: number) => {
    const logMove = history.length >= 60 ? quantileSorted(history, p) : Math.log(1 + fallback(p));
    return Math.exp(anchor == null ? logMove : logMove - median + anchor) - 1;
  };
  const tilt = regime === "bull" ? 0.05 : regime === "bear" ? -0.05 : 0;
  return [
    { id: "bull", name: "Risk-on expansion", description: "Liquidity and momentum broaden; alts outperform with higher beta.", probability: 0.25 + tilt, btcMove: move(0.8), altBeta: 1.2, altDrift: 0, volMultiplier: 1, corrStress: 0.1 },
    { id: "base", name: "Base case", description: "Median historical path for this horizon at today's volatility.", probability: 0.45, btcMove: move(0.5), altBeta: 1, altDrift: 0, volMultiplier: 1, corrStress: 0 },
    { id: "bear", name: "Deleveraging", description: "Risk reduction: volatility rises and correlations tighten.", probability: 0.22 - tilt, btcMove: move(0.2), altBeta: 1.2, altDrift: 0, volMultiplier: 1.3, corrStress: 0.4 },
    { id: "crash", name: "Liquidity crunch", description: "Tail event: forced selling, volatility doubles, everything correlates.", probability: 0.08, btcMove: Math.min(move(0.03), -0.25 * scale), altBeta: 1.4, altDrift: 0, volMultiplier: 2, corrStress: 0.8 },
  ];
}

export function applyScenario(params: RiskParams, scenario: Scenario): RiskParams {
  return {
    ...params,
    btcMove: scenario.btcMove,
    altBeta: scenario.altBeta,
    altDrift: scenario.altDrift,
    volMultiplier: params.volMultiplier * scenario.volMultiplier,
    corrStress: Math.max(params.corrStress, scenario.corrStress),
  };
}

export type ScenarioAnalysis = {
  scenarios: Array<{ scenario: Scenario; weight: number; centralReturn: number; summary: DistributionSummary }>;
  mixture: DistributionSummary;
  mixtureHistogram: ReturnType<typeof histogram>;
  /** Probability-weighted expected return across scenarios. */
  expectedReturn: number;
  /** Probability-weighted median-path return. */
  weightedCentralReturn: number;
};

export function runScenarioAnalysis(model: RiskModel, base: RiskParams, scenarios: Scenario[], paths = 6000): ScenarioAnalysis {
  const totalProbability = scenarios.reduce((sum, scenario) => sum + Math.max(0, scenario.probability), 0) || 1;
  const weights = scenarios.map((scenario) => Math.max(0, scenario.probability) / totalProbability);
  const counts = weights.map((weight) => Math.max(200, Math.round(weight * paths)));
  const mixture: number[] = [];
  const perScenario = scenarios.map((scenario, index) => {
    const params = { ...applyScenario(base, scenario), paths: counts[index], seed: base.seed + index * 7919 };
    const returns = simulatePortfolioReturns(model, params);
    // The mixture samples each scenario in proportion to its probability.
    const take = Math.round(weights[index] * paths);
    for (let path = 0; path < Math.min(take, returns.length); path += 1) mixture.push(returns[path]);
    return { scenario, weight: weights[index], centralReturn: centralReturn(model, params), summary: summarize(returns) };
  });
  return {
    scenarios: perScenario,
    mixture: summarize(mixture),
    mixtureHistogram: histogram(mixture),
    expectedReturn: perScenario.reduce((sum, item) => sum + item.weight * item.summary.mean, 0),
    weightedCentralReturn: perScenario.reduce((sum, item) => sum + item.weight * item.centralReturn, 0),
  };
}

// ---------------------------------------------------------------------------
// Strategic alternatives
// ---------------------------------------------------------------------------

export type Strategy = { id: string; name: string; description: string; weights: number[] };

export function buildStrategies(model: RiskModel, current: number[]): Strategy[] {
  const invested = current.reduce((sum, weight) => sum + weight, 0);
  const n = model.symbols.length;
  const btc = model.benchmarkIndex;
  const eth = model.symbols.indexOf("ETH");
  const held = current.map((weight, index) => (weight > 0 ? index : -1)).filter((index) => index >= 0);
  const universe = held.length ? held : Array.from({ length: n }, (_, index) => index);
  const inverseVol = new Array<number>(n).fill(0);
  const inverseSum = universe.reduce((sum, index) => sum + 1 / Math.max(1e-6, model.volDaily[index]), 0);
  for (const index of universe) inverseVol[index] = (invested * (1 / Math.max(1e-6, model.volDaily[index]))) / inverseSum;
  const equal = new Array<number>(n).fill(0);
  for (const index of universe) equal[index] = invested / universe.length;
  const majors = new Array<number>(n).fill(0);
  if (eth >= 0) {
    majors[btc] = invested * 0.6;
    majors[eth] = invested * 0.4;
  } else majors[btc] = invested;
  return [
    { id: "current", name: "Current allocation", description: "Weights as entered.", weights: [...current] },
    { id: "derisk", name: "De-risk 50%", description: "Halve every position; the rest moves to cash/stablecoins.", weights: current.map((weight) => weight * 0.5) },
    { id: "majors", name: "BTC/ETH only", description: "Same invested amount, 60/40 in BTC and ETH.", weights: majors },
    { id: "risk_parity", name: "Inverse-volatility", description: "Same holdings sized so each contributes similar standalone volatility.", weights: inverseVol },
    { id: "equal", name: "Equal weight", description: "Same holdings, equal dollar weights.", weights: equal },
  ];
}

export type StrategyComparison = {
  strategy: Strategy;
  expectedReturn: number;
  median: number;
  var95: number;
  cvar95: number;
  probLoss: number;
  /** Expected return per unit of 95% expected shortfall. */
  returnPerRisk: number;
};

export function compareStrategies(model: RiskModel, base: RiskParams, scenarios: Scenario[], strategies: Strategy[], paths = 3000): StrategyComparison[] {
  return strategies.map((strategy) => {
    const analysis = runScenarioAnalysis(model, { ...base, weights: strategy.weights }, scenarios, paths);
    return {
      strategy,
      expectedReturn: analysis.expectedReturn,
      median: analysis.mixture.median,
      var95: analysis.mixture.var95,
      cvar95: analysis.mixture.cvar95,
      probLoss: analysis.mixture.probLoss,
      returnPerRisk: analysis.mixture.cvar95 > 0 ? analysis.expectedReturn / analysis.mixture.cvar95 : 0,
    };
  });
}

// ---------------------------------------------------------------------------
// Sensitivity analysis
// ---------------------------------------------------------------------------

export type SensitivityMetric = "expected" | "median" | "var95" | "cvar95" | "probLoss";

export const SENSITIVITY_METRIC_LABELS: Record<SensitivityMetric, string> = {
  expected: "Expected return",
  median: "Median return",
  var95: "95% VaR (loss)",
  cvar95: "95% CVaR (loss)",
  probLoss: "Probability of loss",
};

export type SensitivityDriver = {
  id: string;
  label: string;
  unit: "pct" | "x" | "days" | "df" | "corr";
  base: number;
  low: number;
  high: number;
  apply: (params: RiskParams, value: number) => RiskParams;
};

export function metricOf(summary: DistributionSummary, metric: SensitivityMetric): number {
  switch (metric) {
    case "expected": return summary.mean;
    case "median": return summary.median;
    case "var95": return summary.var95;
    case "cvar95": return summary.cvar95;
    case "probLoss": return summary.probLoss;
  }
}

/** The benchmark's median move implied by the drift mode, so drivers can shift it. */
export function impliedBenchmarkMove(model: RiskModel, params: RiskParams): number {
  if (params.btcMove != null) return params.btcMove;
  const { drift } = assetDynamics(model, params);
  return Math.exp(drift[model.benchmarkIndex] * params.horizonDays) - 1;
}

export function defaultDrivers(
  model: RiskModel,
  base: RiskParams,
  stablecoinElasticity: { slope: number; r2: number } | null = null,
): SensitivityDriver[] {
  const btcBase = impliedBenchmarkMove(model, base);
  const drivers: SensitivityDriver[] = [
    { id: "btcMove", label: "BTC move over horizon", unit: "pct", base: btcBase, low: btcBase - 0.2, high: btcBase + 0.2, apply: (p, v) => ({ ...p, btcMove: v }) },
    { id: "altBeta", label: "Alt beta to BTC", unit: "x", base: base.altBeta, low: base.altBeta * 0.7, high: base.altBeta * 1.3, apply: (p, v) => ({ ...p, altBeta: v }) },
    { id: "volMultiplier", label: "Volatility level", unit: "x", base: base.volMultiplier, low: base.volMultiplier * 0.75, high: base.volMultiplier * 1.5, apply: (p, v) => ({ ...p, volMultiplier: v }) },
    { id: "corrStress", label: "Correlation stress", unit: "corr", base: base.corrStress, low: Math.max(0, base.corrStress - 0.3), high: Math.min(1, base.corrStress + 0.6), apply: (p, v) => ({ ...p, corrStress: v }) },
    { id: "tailDf", label: "Tail thickness (t d.o.f.)", unit: "df", base: base.tailDf, low: 200, high: 3, apply: (p, v) => ({ ...p, tailDf: v }) },
    { id: "altDrift", label: "Alt-specific drift", unit: "pct", base: base.altDrift, low: base.altDrift - 0.1, high: base.altDrift + 0.1, apply: (p, v) => ({ ...p, altDrift: v }) },
    { id: "exposure", label: "Position size (exposure)", unit: "x", base: base.exposure, low: base.exposure * 0.5, high: base.exposure * 1.5, apply: (p, v) => ({ ...p, exposure: v }) },
    {
      id: "horizonDays", label: "Holding horizon", unit: "days", base: base.horizonDays,
      low: Math.max(1, Math.round(base.horizonDays / 2)), high: base.horizonDays * 2,
      // Keep the daily trend constant when the horizon changes.
      apply: (p, v) => ({ ...p, horizonDays: v, btcMove: p.btcMove == null ? null : Math.pow(1 + p.btcMove, v / p.horizonDays) - 1 }),
    },
  ];
  if (stablecoinElasticity && stablecoinElasticity.r2 >= 0.02 && Number.isFinite(stablecoinElasticity.slope)) {
    drivers.push({
      id: "stablecoinShock", label: "Stablecoin supply shock (30d)", unit: "pct", base: 0, low: -0.03, high: 0.03,
      apply: (p, v) => ({ ...p, btcMove: (1 + (p.btcMove ?? 0)) * Math.exp(stablecoinElasticity.slope * Math.log(1 + v)) - 1 }),
    });
  }
  return drivers;
}

export type SensitivityRow = {
  id: string;
  label: string;
  unit: SensitivityDriver["unit"];
  low: number;
  high: number;
  lowValue: number;
  highValue: number;
  swing: number;
};

export type SensitivityResult = {
  metric: SensitivityMetric;
  baseValue: number;
  rows: SensitivityRow[];
  /** Drivers that together explain at least 80% of total squared swing. */
  critical: string[];
};

export function runSensitivity(
  model: RiskModel,
  base: RiskParams,
  drivers: SensitivityDriver[],
  metric: SensitivityMetric,
  paths = 4000,
): SensitivityResult {
  const shocks = drawShocks(model.symbols.length, paths, base.seed);
  // Evaluate every driver around the same explicit benchmark move.
  const anchored: RiskParams = { ...base, btcMove: impliedBenchmarkMove(model, base), paths };
  const evaluate = (params: RiskParams) => metricOf(summarize(simulatePortfolioReturns(model, params, shocks)), metric);
  const baseValue = evaluate(anchored);
  const rows = drivers.map((driver) => {
    const lowValue = evaluate(driver.apply(anchored, driver.low));
    const highValue = evaluate(driver.apply(anchored, driver.high));
    return { id: driver.id, label: driver.label, unit: driver.unit, low: driver.low, high: driver.high, lowValue, highValue, swing: Math.abs(highValue - lowValue) };
  }).sort((a, b) => b.swing - a.swing);
  const total = rows.reduce((sum, row) => sum + row.swing ** 2, 0);
  const critical: string[] = [];
  let cumulative = 0;
  for (const row of rows) {
    if (total <= 0) break;
    critical.push(row.id);
    cumulative += row.swing ** 2;
    if (cumulative / total >= 0.8) break;
  }
  return { metric, baseValue, rows, critical };
}

export type DataTable = { metric: SensitivityMetric; xValues: number[]; yValues: number[]; grid: number[][] };

export function runDataTable(
  model: RiskModel,
  base: RiskParams,
  xDriver: SensitivityDriver,
  xValues: number[],
  yDriver: SensitivityDriver,
  yValues: number[],
  metric: SensitivityMetric,
  paths = 2500,
): DataTable {
  const shocks = drawShocks(model.symbols.length, paths, base.seed);
  const anchored: RiskParams = { ...base, btcMove: impliedBenchmarkMove(model, base), paths };
  const grid = yValues.map((y) => xValues.map((x) => {
    const params = xDriver.apply(yDriver.apply(anchored, y), x);
    return metricOf(summarize(simulatePortfolioReturns(model, params, shocks)), metric);
  }));
  return { metric, xValues, yValues, grid };
}

// ---------------------------------------------------------------------------
// Risk attribution and model validation
// ---------------------------------------------------------------------------

/** Share of portfolio variance contributed by each holding (sums to 1). */
export function riskContributions(model: RiskModel, params: Pick<RiskParams, "weights" | "exposure" | "volMultiplier">): number[] {
  const { weights } = effectiveWeights({ weights: params.weights, exposure: params.exposure });
  const vol = model.volDaily.map((value) => value * params.volMultiplier);
  const n = weights.length;
  const marginal = new Array<number>(n).fill(0);
  let variance = 0;
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) marginal[i] += model.correlation[i][j] * vol[i] * vol[j] * weights[j];
    variance += weights[i] * marginal[i];
  }
  return variance > 0 ? weights.map((weight, index) => (weight * marginal[index]) / variance) : weights.map(() => 0);
}

/** Daily simple returns of the portfolio with daily rebalancing to the weights. */
export function historicalPortfolioReturns(model: RiskModel, weights: number[]): number[] {
  const days = model.returns[0]?.length ?? 0;
  const result: number[] = [];
  for (let t = 0; t < days; t += 1) {
    let value = 0;
    for (let i = 0; i < weights.length; i += 1) value += weights[i] * (Math.exp(model.returns[i][t]) - 1);
    result.push(value);
  }
  return result;
}

export type VarBacktest = {
  tested: number;
  exceptions: number;
  expected: number;
  rate: number;
  lrStatistic: number;
  pValue: number;
  verdict: "calibrated" | "underestimates risk" | "overestimates risk" | "insufficient data";
};

/**
 * Kupiec proportion-of-failures test: does a rolling historical 1-day VaR get
 * breached about as often as its confidence level promises?
 */
export function kupiecBacktest(returns: number[], level = 0.95, lookback = 90, window = 250): VarBacktest {
  const start = Math.max(lookback, returns.length - window);
  let tested = 0;
  let exceptions = 0;
  for (let t = start; t < returns.length; t += 1) {
    const history = returns.slice(t - lookback, t).sort((a, b) => a - b);
    const varThreshold = quantileSorted(history, 1 - level);
    tested += 1;
    if (returns[t] < varThreshold) exceptions += 1;
  }
  const p = 1 - level;
  if (tested < 60) return { tested, exceptions, expected: tested * p, rate: tested ? exceptions / tested : 0, lrStatistic: 0, pValue: 1, verdict: "insufficient data" };
  const rate = exceptions / tested;
  const logLikelihood = (probability: number) =>
    (tested - exceptions) * Math.log(Math.max(1e-12, 1 - probability)) + exceptions * Math.log(Math.max(1e-12, probability));
  const lrStatistic = Math.max(0, -2 * (logLikelihood(p) - logLikelihood(Math.min(Math.max(rate, 1e-9), 1 - 1e-9))));
  const pValue = chiSquare1PValue(lrStatistic);
  return {
    tested,
    exceptions,
    expected: tested * p,
    rate,
    lrStatistic,
    pValue,
    verdict: pValue >= 0.05 ? "calibrated" : rate > p ? "underestimates risk" : "overestimates risk",
  };
}

/** OLS elasticity of the benchmark's 30-day log return to the 30-day log change in stablecoin supply. */
export function stablecoinElasticity(benchmarkDailyLog: number[], stablecoinSupply: Array<number | null>, horizon = 30, step = 7) {
  const x: number[] = [];
  const y: number[] = [];
  const n = Math.min(benchmarkDailyLog.length + 1, stablecoinSupply.length);
  for (let end = horizon; end < n; end += step) {
    const startSupply = stablecoinSupply[end - horizon];
    const endSupply = stablecoinSupply[end];
    if (startSupply == null || endSupply == null || startSupply <= 0 || endSupply <= 0) continue;
    let btc = 0;
    for (let t = end - horizon; t < end; t += 1) btc += benchmarkDailyLog[t] ?? 0;
    x.push(Math.log(endSupply / startSupply));
    y.push(btc);
  }
  const fit = ols(x, y);
  return fit ? { slope: fit.slope, r2: fit.r2, tStat: fit.tStat, n: fit.n } : null;
}
