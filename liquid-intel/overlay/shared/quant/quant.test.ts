import assert from "node:assert/strict";
import test from "node:test";
import { Rng } from "./rng";
import { chiSquare1PValue, ols, quantile, spearman } from "./stats";
import {
  buildRiskModel,
  buildStrategies,
  calibrateScenarios,
  compareStrategies,
  DEFAULT_RISK_PARAMS,
  defaultDrivers,
  kupiecBacktest,
  riskContributions,
  runDataTable,
  runMonteCarlo,
  runScenarioAnalysis,
  runSensitivity,
  simulatePaths,
  type RiskInputs,
  type RiskParams,
} from "./risk";
import { computeMarketStructure, validateSignal, type DailyPanel } from "./structure";

function syntheticInputs(days = 400, seed = 7): RiskInputs {
  const rng = new Rng(seed);
  const vols = [0.03, 0.04, 0.05];
  const loadings = [1, 0.85, 0.75];
  const returns: number[][] = [[], [], []];
  for (let t = 0; t < days; t += 1) {
    const market = rng.normal();
    for (let i = 0; i < 3; i += 1) {
      const idio = rng.normal();
      returns[i].push(vols[i] * (loadings[i] * market + Math.sqrt(1 - loadings[i] ** 2) * idio));
    }
  }
  return { symbols: ["BTC", "ETH", "SOL"], dates: Array.from({ length: days }, (_, index) => String(index)), returns, prices: [60_000, 3_000, 150] };
}

const model = buildRiskModel(syntheticInputs());
const base: RiskParams = { ...DEFAULT_RISK_PARAMS, weights: [0.5, 0.3, 0.2], paths: 6000 };

test("the seeded RNG is reproducible and produces standard normals", () => {
  const a = new Rng(42);
  const b = new Rng(42);
  assert.equal(a.next(), b.next());
  const draws = Array.from({ length: 20_000 }, () => a.normal());
  const mean = draws.reduce((sum, value) => sum + value, 0) / draws.length;
  const sd = Math.sqrt(draws.reduce((sum, value) => sum + (value - mean) ** 2, 0) / draws.length);
  assert.ok(Math.abs(mean) < 0.03);
  assert.ok(Math.abs(sd - 1) < 0.03);
});

test("basic statistics behave", () => {
  assert.equal(quantile([1, 2, 3, 4, 5], 0.5), 3);
  assert.equal(spearman([1, 2, 3, 4], [10, 20, 30, 40]), 1);
  const fit = ols([1, 2, 3, 4, 5], [2.1, 3.9, 6.2, 7.8, 10.1]);
  assert.ok(fit && Math.abs(fit.slope - 2) < 0.1 && fit.r2 > 0.99);
  assert.ok(Math.abs(chiSquare1PValue(3.841) - 0.05) < 0.002);
});

test("the risk model recovers volatility, correlation, and beta from history", () => {
  assert.equal(model.benchmarkIndex, 0);
  assert.ok(Math.abs(model.sampleVolDaily[0] - 0.03) < 0.004);
  assert.ok(model.correlation[0][1] > 0.6 && model.correlation[0][1] < 0.95);
  assert.ok(model.beta[2] > 0.9);
});

test("Monte Carlo reports ordered confidence intervals and coherent tail risk", () => {
  const { summary } = runMonteCarlo(model, base);
  assert.equal(summary.n, 6000);
  assert.ok(summary.ci95[0] < summary.ci90[0] && summary.ci90[0] < summary.median && summary.median < summary.ci90[1] && summary.ci90[1] < summary.ci95[1]);
  assert.ok(summary.var95 > 0.1, `30-day VaR95 should be material for crypto, got ${summary.var95}`);
  assert.ok(summary.cvar95 >= summary.var95);
  assert.ok(summary.var99 >= summary.var95);
  // Neutral drift means no assumed edge: the median path is close to flat.
  assert.ok(Math.abs(summary.median) < 0.06);
  // Same seed, same answer.
  assert.equal(runMonteCarlo(model, base).summary.var95, summary.var95);
});

test("fat tails and correlation stress raise tail risk", () => {
  const gaussian = runMonteCarlo(model, { ...base, tailDf: 200 }).summary;
  const fat = runMonteCarlo(model, { ...base, tailDf: 3 }).summary;
  assert.ok(fat.var99 > gaussian.var99);
  const stressed = runMonteCarlo(model, { ...base, corrStress: 1 }).summary;
  assert.ok(stressed.var95 > runMonteCarlo(model, base).summary.var95);
});

test("path simulation produces widening fan bands and drawdown odds", () => {
  const paths = simulatePaths(model, base, 800, 30);
  const first = paths.bands[1];
  const last = paths.bands[paths.bands.length - 1];
  assert.ok(last.p95 - last.p5 > first.p95 - first.p5);
  assert.ok(paths.maxDrawdown.p95 >= paths.maxDrawdown.median);
  assert.ok(paths.maxDrawdown.probOver20 >= 0 && paths.maxDrawdown.probOver20 <= 1);
});

test("scenario analysis returns a probability-weighted expected value", () => {
  const scenarios = calibrateScenarios(model, 30, "transition");
  assert.equal(scenarios.length, 4);
  assert.ok(Math.abs(scenarios.reduce((sum, scenario) => sum + scenario.probability, 0) - 1) < 1e-9);
  assert.ok(scenarios[0].btcMove > scenarios[1].btcMove && scenarios[1].btcMove > scenarios[2].btcMove && scenarios[2].btcMove > scenarios[3].btcMove);
  const analysis = runScenarioAnalysis(model, base, scenarios, 4000);
  const weighted = analysis.scenarios.reduce((sum, item) => sum + item.weight * item.summary.mean, 0);
  assert.ok(Math.abs(analysis.expectedReturn - weighted) < 1e-12);
  const crash = analysis.scenarios.find((item) => item.scenario.id === "crash")!;
  const bull = analysis.scenarios.find((item) => item.scenario.id === "bull")!;
  assert.ok(crash.summary.mean < bull.summary.mean);
  assert.ok(analysis.mixture.var95 > 0);
});

test("centered scenarios keep the historical spread around the simulation's own BTC assumption", () => {
  const raw = calibrateScenarios(model, 30);
  const centered = calibrateScenarios(model, 30, "transition", 0);
  const base = centered.find((scenario) => scenario.id === "base")!;
  assert.ok(Math.abs(base.btcMove) < 1e-9);
  const spread = (list: typeof raw) => Math.log(1 + list[0].btcMove) - Math.log(1 + list[2].btcMove);
  assert.ok(Math.abs(spread(raw) - spread(centered)) < 1e-9);
  const view = calibrateScenarios(model, 30, "transition", 0.1).find((scenario) => scenario.id === "base")!;
  assert.ok(Math.abs(view.btcMove - 0.1) < 1e-9);
});

test("de-risking lowers tail risk in the strategy comparison", () => {
  const scenarios = calibrateScenarios(model, 30);
  const results = compareStrategies(model, base, scenarios, buildStrategies(model, base.weights), 2000);
  const current = results.find((item) => item.strategy.id === "current")!;
  const derisk = results.find((item) => item.strategy.id === "derisk")!;
  assert.ok(derisk.cvar95 < current.cvar95);
  assert.ok(Math.abs(derisk.cvar95 - current.cvar95 * 0.5) < current.cvar95 * 0.1);
});

test("sensitivity ranks drivers with common random numbers and names the critical ones", () => {
  const result = runSensitivity(model, base, defaultDrivers(model, base), "var95", 3000);
  for (let index = 1; index < result.rows.length; index += 1) assert.ok(result.rows[index - 1].swing >= result.rows[index].swing);
  assert.ok(result.critical.length >= 1 && result.critical.length < result.rows.length);
  const exposure = result.rows.find((row) => row.id === "exposure")!;
  assert.ok(exposure.highValue > exposure.lowValue, "more exposure must mean more VaR");
  const vol = result.rows.find((row) => row.id === "volMultiplier")!;
  assert.ok(vol.highValue > vol.lowValue);
});

test("two-variable data tables are monotonic in exposure", () => {
  const drivers = defaultDrivers(model, base);
  const exposure = drivers.find((driver) => driver.id === "exposure")!;
  const vol = drivers.find((driver) => driver.id === "volMultiplier")!;
  const table = runDataTable(model, base, exposure, [0.5, 1, 1.5], vol, [0.8, 1, 1.5], "var95", 1500);
  for (const row of table.grid) assert.ok(row[0] < row[1] && row[1] < row[2]);
  for (let column = 0; column < 3; column += 1) assert.ok(table.grid[0][column] < table.grid[2][column]);
});

test("risk contributions sum to one", () => {
  const contributions = riskContributions(model, base);
  assert.ok(Math.abs(contributions.reduce((sum, value) => sum + value, 0) - 1) < 1e-9);
  assert.ok(contributions[0] > contributions[2] * 0.5);
});

test("the Kupiec backtest accepts a calibrated VaR and flags a regime break", () => {
  const rng = new Rng(3);
  const calm = Array.from({ length: 600 }, () => 0.02 * rng.normal());
  assert.equal(kupiecBacktest(calm).verdict, "calibrated");
  const broken = [...calm.slice(0, 400), ...Array.from({ length: 250 }, () => 0.06 * rng.normal())];
  assert.equal(kupiecBacktest(broken).verdict, "underestimates risk");
  assert.equal(kupiecBacktest(calm.slice(0, 100)).verdict, "insufficient data");
});

function syntheticPanel(days: number, drifts: Record<string, number>, seed = 11, noise = 0.025): DailyPanel {
  const rng = new Rng(seed);
  const dates = Array.from({ length: days }, (_, index) => new Date(Date.UTC(2025, 0, 1) + index * 86_400_000).toISOString().slice(0, 10));
  const closes: DailyPanel["closes"] = {};
  const volumes: DailyPanel["volumes"] = {};
  for (const [symbol, drift] of Object.entries(drifts)) {
    let price = 100;
    closes[symbol] = [];
    volumes[symbol] = [];
    for (let t = 0; t < days; t += 1) {
      price *= Math.exp(drift + noise * rng.normal());
      closes[symbol].push(price);
      volumes[symbol].push(1e8 * (1 + 0.2 * rng.normal() ** 2));
    }
  }
  const supply = dates.map((_, index) => 1.5e11 * Math.exp(0.0003 * index));
  return { dates, closes, volumes, stablecoinSupply: supply, totalTvl: supply.map((value) => value * 0.6), dexVolume: supply.map(() => 5e9), fearGreed: dates.map(() => 55) };
}

test("market structure scores trends by risk-adjusted strength and detects the regime", () => {
  const panel = syntheticPanel(400, { BTC: 0.004, ETH: 0.006, SOL: -0.006, LINK: 0, AAVE: 0.002, UNI: -0.002 }, 11, 0.012);
  const structure = computeMarketStructure(panel);
  const bySymbol = new Map(structure.assets.map((asset) => [asset.symbol, asset]));
  assert.ok(bySymbol.get("ETH")!.composite > 30);
  assert.ok(bySymbol.get("SOL")!.composite < -30);
  assert.ok(bySymbol.get("ETH")!.composite > bySymbol.get("SOL")!.composite);
  assert.equal(structure.regime.trend, "bull");
  for (const asset of structure.assets) assert.ok(asset.composite >= -100 && asset.composite <= 100);
  assert.ok(structure.breadth.above200 != null);
  assert.ok(structure.insights.some((insight) => insight.id === "regime"));
});

test("signal validation is honest about data limits", () => {
  const short = syntheticPanel(150, { BTC: 0, ETH: 0, SOL: 0, LINK: 0, AAVE: 0 });
  assert.equal(validateSignal(short, 7).verdict, "insufficient data");
  const noise = syntheticPanel(400, { BTC: 0, ETH: 0, SOL: 0, LINK: 0, AAVE: 0, UNI: 0, DOT: 0, ATOM: 0 }, 99);
  const result = validateSignal(noise, 7);
  assert.ok(result.evaluations >= 8);
  assert.notEqual(result.verdict, "predictive", "pure noise must not be reported as a predictive signal");
});
