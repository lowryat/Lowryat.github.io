/** Small, dependency-free statistics used by the risk and market-structure engines. */

export function mean(values: readonly number[]): number {
  if (!values.length) return NaN;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

export function variance(values: readonly number[]): number {
  if (values.length < 2) return NaN;
  const average = mean(values);
  let sum = 0;
  for (const value of values) sum += (value - average) ** 2;
  return sum / (values.length - 1);
}

export function stdev(values: readonly number[]): number {
  return Math.sqrt(variance(values));
}

/** Linear-interpolated quantile (type 7) of an already-sorted array. */
export function quantileSorted(sorted: ArrayLike<number>, q: number): number {
  const n = sorted.length;
  if (!n) return NaN;
  if (n === 1) return sorted[0];
  const position = Math.min(Math.max(q, 0), 1) * (n - 1);
  const lower = Math.floor(position);
  const upper = Math.min(n - 1, lower + 1);
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

export function quantile(values: readonly number[], q: number): number {
  return quantileSorted([...values].sort((a, b) => a - b), q);
}

export function median(values: readonly number[]): number {
  return quantile(values, 0.5);
}

/** Median absolute deviation scaled to be consistent with a normal stdev. */
export function robustScale(values: readonly number[]): number {
  if (values.length < 3) return NaN;
  const center = median(values);
  return 1.4826 * median(values.map((value) => Math.abs(value - center)));
}

/** Robust z-score of `value` against a reference sample (median / MAD). */
export function robustZ(value: number, sample: readonly number[]): number | null {
  const scale = robustScale(sample);
  if (!Number.isFinite(scale) || scale === 0) return null;
  return (value - median(sample)) / scale;
}

export function pearson(x: readonly number[], y: readonly number[]): number | null {
  const n = Math.min(x.length, y.length);
  if (n < 3) return null;
  const mx = mean(x.slice(0, n));
  const my = mean(y.slice(0, n));
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let index = 0; index < n; index += 1) {
    const dx = x[index] - mx;
    const dy = y[index] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  const denominator = Math.sqrt(sxx * syy);
  return denominator > 0 ? sxy / denominator : null;
}

/** Average ranks (ties share the mean rank). */
export function ranks(values: readonly number[]): number[] {
  const order = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const result = new Array<number>(values.length);
  let start = 0;
  while (start < order.length) {
    let end = start;
    while (end + 1 < order.length && order[end + 1].value === order[start].value) end += 1;
    const rank = (start + end) / 2 + 1;
    for (let index = start; index <= end; index += 1) result[order[index].index] = rank;
    start = end + 1;
  }
  return result;
}

export function spearman(x: readonly number[], y: readonly number[]): number | null {
  if (x.length !== y.length || x.length < 3) return null;
  return pearson(ranks(x), ranks(y));
}

export type Regression = { slope: number; intercept: number; r2: number; tStat: number; n: number };

/** Ordinary least squares y = a + b x with the slope's t-statistic. */
export function ols(x: readonly number[], y: readonly number[]): Regression | null {
  const n = Math.min(x.length, y.length);
  if (n < 4) return null;
  const mx = mean(x.slice(0, n));
  const my = mean(y.slice(0, n));
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let index = 0; index < n; index += 1) {
    sxy += (x[index] - mx) * (y[index] - my);
    sxx += (x[index] - mx) ** 2;
    syy += (y[index] - my) ** 2;
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  const ssRes = syy - slope * sxy;
  const r2 = syy > 0 ? 1 - ssRes / syy : 0;
  const se = Math.sqrt(Math.max(ssRes, 0) / (n - 2) / sxx);
  return { slope, intercept, r2, tStat: se > 0 ? slope / se : 0, n };
}

export function logReturns(closes: readonly number[]): number[] {
  const result: number[] = [];
  for (let index = 1; index < closes.length; index += 1) {
    const previous = closes[index - 1];
    const current = closes[index];
    result.push(previous > 0 && current > 0 ? Math.log(current / previous) : 0);
  }
  return result;
}

/** RiskMetrics EWMA volatility (daily) of a return series. */
export function ewmaVolatility(returns: readonly number[], lambda = 0.94): number {
  if (!returns.length) return NaN;
  const seedWindow = returns.slice(0, Math.min(30, returns.length));
  let varianceEstimate = seedWindow.reduce((sum, value) => sum + value * value, 0) / seedWindow.length;
  for (const value of returns) varianceEstimate = lambda * varianceEstimate + (1 - lambda) * value * value;
  return Math.sqrt(varianceEstimate);
}

export function simpleMovingAverage(values: readonly number[], window: number, end = values.length): number | null {
  if (end < window) return null;
  let sum = 0;
  for (let index = end - window; index < end; index += 1) sum += values[index];
  return sum / window;
}

/** Wilder's RSI over `period` using closes up to (not including) `end`. */
export function rsi(closes: readonly number[], period = 14, end = closes.length): number | null {
  if (end <= period) return null;
  let gain = 0;
  let loss = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = closes[index] - closes[index - 1];
    if (change >= 0) gain += change; else loss -= change;
  }
  gain /= period;
  loss /= period;
  for (let index = period + 1; index < end; index += 1) {
    const change = closes[index] - closes[index - 1];
    gain = (gain * (period - 1) + Math.max(change, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-change, 0)) / period;
  }
  if (loss === 0) return gain === 0 ? 50 : 100;
  return 100 - 100 / (1 + gain / loss);
}

/** Largest peak-to-trough decline as a positive fraction. */
export function maxDrawdown(values: readonly number[]): number {
  let peak = -Infinity;
  let worst = 0;
  for (const value of values) {
    if (value > peak) peak = value;
    if (peak > 0) worst = Math.max(worst, 1 - value / peak);
  }
  return worst;
}

/** Share of the sample at or below `value`. */
export function percentRank(sample: readonly number[], value: number): number | null {
  if (!sample.length) return null;
  let below = 0;
  for (const item of sample) if (item <= value) below += 1;
  return below / sample.length;
}

/** Complementary error function (Numerical Recipes erfcc, ~1e-7 accuracy). */
export function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418
    + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587
    + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? r : 2 - r;
}

/** Upper-tail p-value of a chi-square(1) statistic. */
export function chiSquare1PValue(statistic: number): number {
  if (!(statistic > 0)) return 1;
  return erfc(Math.sqrt(statistic / 2));
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
