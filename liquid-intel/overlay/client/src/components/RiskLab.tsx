import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AlertTriangle, Calculator, Dice5, FlaskConical, Info, Loader2, Scale, Shuffle, Target } from "lucide-react";
import { Area, Bar, BarChart, CartesianGrid, Cell, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import {
  buildRiskModel,
  buildStrategies,
  calibrateScenarios,
  compareStrategies,
  DEFAULT_RISK_PARAMS,
  defaultDrivers,
  effectiveWeights,
  historicalPortfolioReturns,
  impliedBenchmarkMove,
  kupiecBacktest,
  riskContributions,
  runDataTable,
  runMonteCarlo,
  runScenarioAnalysis,
  runSensitivity,
  SENSITIVITY_METRIC_LABELS,
  simulatePaths,
  type RiskModel,
  type RiskParams,
  type Scenario,
  type SensitivityDriver,
  type SensitivityMetric,
} from "@shared/quant/risk";
import type { RiskLabModel } from "@shared/quant/api-types";
import { SYMS } from "@/lib/crypto-utils";
import { historyFromError, pct, usd, useRiskLabModel } from "@/lib/quant-api";

type Assumptions = {
  horizonDays: number;
  driftMode: "neutral" | "historical";
  tailDf: number;
  volMultiplier: number;
  corrStress: number;
  /** Median BTC move over the horizon in percent, or null for no view. */
  btcView: number | null;
  exposure: number;
  paths: number;
  seed: number;
};

const DEFAULT_ASSUMPTIONS: Assumptions = {
  horizonDays: 30,
  driftMode: "neutral",
  tailDf: 4,
  volMultiplier: 1,
  corrStress: 0,
  btcView: null,
  exposure: 1,
  paths: 5000,
  seed: DEFAULT_RISK_PARAMS.seed,
};

const METRICS: SensitivityMetric[] = ["var95", "cvar95", "expected", "median", "probLoss"];
const TAIL_OPTIONS = [
  { value: 200, label: "Normal" },
  { value: 6, label: "Moderate (t6)" },
  { value: 4, label: "Fat (t4)" },
  { value: 3, label: "Very fat (t3)" },
];

function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

function formatMetric(metric: SensitivityMetric, value: number): string {
  if (metric === "probLoss") return pct(value, 1, false);
  if (metric === "var95" || metric === "cvar95") return `${pct(value, 1, false)} loss`;
  return pct(value, 1);
}

function formatDriverValue(driver: Pick<SensitivityDriver, "unit">, value: number): string {
  switch (driver.unit) {
    case "pct": return pct(value, 0);
    case "x": return `${value.toFixed(2)}x`;
    case "days": return `${Math.round(value)}d`;
    case "df": return value >= 200 ? "Normal" : `t${Math.round(value)}`;
    case "corr": return value.toFixed(2);
  }
}

function driverGrid(driver: SensitivityDriver): number[] {
  if (driver.id === "tailDf") return [200, 10, 6, 4, 3];
  if (driver.id === "horizonDays") return [7, 14, 30, 60, 90].filter((value) => value >= 1);
  return Array.from({ length: 5 }, (_, index) => driver.low + ((driver.high - driver.low) * index) / 4);
}

/** Restricts the full universe to the held assets, keeping BTC first as the benchmark. */
function subsetInputs(model: RiskLabModel, held: string[]) {
  const symbols = ["BTC", ...held.filter((symbol) => symbol !== "BTC" && model.symbols.includes(symbol))];
  const indexes = symbols.map((symbol) => model.symbols.indexOf(symbol));
  return {
    symbols,
    dates: model.dates,
    returns: indexes.map((index) => model.returns[index]),
    prices: indexes.map((index) => model.prices[index]),
  };
}

type Results = {
  model: RiskModel;
  params: RiskParams;
  scenarios: Scenario[];
  mc: ReturnType<typeof runMonteCarlo>;
  fan: ReturnType<typeof simulatePaths>;
  scenario: ReturnType<typeof runScenarioAnalysis>;
  strategies: ReturnType<typeof compareStrategies>;
  drivers: SensitivityDriver[];
  sensitivity: ReturnType<typeof runSensitivity>;
  table: ReturnType<typeof runDataTable> | null;
  tableX: SensitivityDriver | null;
  tableY: SensitivityDriver | null;
  contributions: number[];
  backtest: ReturnType<typeof kupiecBacktest>;
  elapsedMs: number;
};

export function RiskLab() {
  const [lookback, setLookback] = useState(365);
  const query = useRiskLabModel(lookback);
  const data = query.data;
  const [weights, setWeights] = useState<Record<string, number>>({});
  const [assumptions, setAssumptions] = useState<Assumptions>(DEFAULT_ASSUMPTIONS);
  const [probabilities, setProbabilities] = useState<Record<string, number>>({});
  const [metric, setMetric] = useState<SensitivityMetric>("var95");
  const [tableX, setTableX] = useState("btcMove");
  const [tableY, setTableY] = useState("volMultiplier");
  const [portfolioValue, setPortfolioValue] = useState(10_000);

  useEffect(() => {
    if (!data || Object.keys(weights).length) return;
    setWeights(Object.fromEntries(data.symbols.map((symbol, index) => [symbol, Math.round((data.defaultWeights[index] ?? 0) * 100)])));
  }, [data, weights]);

  const inputs = useDebounced({ weights, assumptions, probabilities, metric, tableX, tableY }, 350);

  const results = useMemo((): Results | { error: string } | null => {
    if (!data) return null;
    const held = Object.entries(inputs.weights).filter(([, weight]) => weight > 0).map(([symbol]) => symbol);
    if (!held.length) return { error: "Enter at least one position to simulate." };
    try {
      const started = performance.now();
      const model = buildRiskModel(subsetInputs(data, held));
      const a = inputs.assumptions;
      const params: RiskParams = {
        ...DEFAULT_RISK_PARAMS,
        weights: model.symbols.map((symbol) => (inputs.weights[symbol] ?? 0) / 100),
        horizonDays: a.horizonDays,
        driftMode: a.driftMode,
        tailDf: a.tailDf,
        volMultiplier: a.volMultiplier,
        corrStress: a.corrStress,
        btcMove: a.btcView == null ? null : a.btcView / 100,
        exposure: a.exposure,
        paths: a.paths,
        seed: a.seed,
      };
      // Scenarios share the simulation's BTC assumption, so the two views never contradict each other.
      const calibrated = calibrateScenarios(model, a.horizonDays, data.regime === "unknown" ? "transition" : data.regime, impliedBenchmarkMove(model, params));
      const scenarios = calibrated.map((scenario) => ({
        ...scenario,
        probability: inputs.probabilities[scenario.id] != null ? inputs.probabilities[scenario.id] / 100 : scenario.probability,
      }));
      const drivers = defaultDrivers(model, params, data.stablecoinElasticity);
      const x = drivers.find((driver) => driver.id === inputs.tableX) ?? null;
      const y = drivers.find((driver) => driver.id === inputs.tableY) ?? null;
      const result: Results = {
        model,
        params,
        scenarios,
        mc: runMonteCarlo(model, params),
        fan: simulatePaths(model, params, Math.min(1500, a.paths), 60),
        scenario: runScenarioAnalysis(model, params, scenarios, a.paths),
        strategies: compareStrategies(model, params, scenarios, buildStrategies(model, params.weights), 2000),
        drivers,
        sensitivity: runSensitivity(model, params, drivers, inputs.metric, 3000),
        table: x && y && x.id !== y.id ? runDataTable(model, params, x, driverGrid(x), y, driverGrid(y), inputs.metric, 2000) : null,
        tableX: x,
        tableY: y,
        contributions: riskContributions(model, params),
        backtest: kupiecBacktest(historicalPortfolioReturns(model, effectiveWeights(params).weights)),
        elapsedMs: 0,
      };
      result.elapsedMs = performance.now() - started;
      return result;
    } catch (error) {
      return { error: error instanceof Error ? error.message : "Simulation failed." };
    }
  }, [data, inputs]);

  const computing = inputs.weights !== weights || inputs.assumptions !== assumptions || inputs.probabilities !== probabilities
    || inputs.metric !== metric || inputs.tableX !== tableX || inputs.tableY !== tableY;

  if (query.isLoading) {
    return <Shell><div className="flex min-h-[300px] items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading daily history…</div></Shell>;
  }
  if (query.error || !data) {
    const history = historyFromError(query.error);
    return (
      <Shell>
        <div className="rounded-xl border border-yellow-500/30 bg-yellow-500/5 p-5 text-sm text-yellow-200">
          <div className="flex items-center gap-2 font-semibold"><AlertTriangle className="h-4 w-4" />{query.error instanceof Error ? query.error.message : "Risk data is unavailable."}</div>
          {history && <p className="mt-2 text-xs text-yellow-100/80">Daily history: {history.state}. {history.assets.filter((row) => row.points > 0).length}/{history.assets.length} assets loaded. This page retries automatically.</p>}
        </div>
      </Shell>
    );
  }

  const investedPct = Object.values(weights).reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
  const setAssumption = <K extends keyof Assumptions>(key: K, value: Assumptions[K]) => setAssumptions((current) => ({ ...current, [key]: value }));

  return (
    <Shell asOf={data.asOf} lookback={data.lookbackDays} excluded={data.excluded}>
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Panel title="Portfolio" icon={<Scale className="h-4 w-4" />} subtitle="Percent of portfolio value per asset. The remainder is cash or stablecoins.">
          <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
            <label className="flex items-center gap-2 text-muted-foreground">Portfolio value
              <input type="number" min={0} step={1000} value={portfolioValue} onChange={(event) => setPortfolioValue(Math.max(0, Number(event.target.value) || 0))} className="w-28 rounded-md border border-border bg-background px-2 py-1 text-right font-mono text-foreground" aria-label="Portfolio value in dollars" />
            </label>
            <button type="button" className="rounded-md border border-border px-2 py-1 text-muted-foreground hover:text-foreground" onClick={() => setWeights(Object.fromEntries(data.symbols.map((symbol, index) => [symbol, Math.round((data.defaultWeights[index] ?? 0) * 100)])))}>Default mix</button>
            <button type="button" className="rounded-md border border-border px-2 py-1 text-muted-foreground hover:text-foreground" onClick={() => setWeights(Object.fromEntries(data.symbols.map((symbol) => [symbol, 0])))}>Clear</button>
          </div>
          <div className="grid max-h-[320px] grid-cols-2 gap-x-4 gap-y-1.5 overflow-y-auto pr-1 sm:grid-cols-3">
            {data.symbols.map((symbol) => (
              <label key={symbol} className="flex items-center justify-between gap-2 rounded-md border border-border/60 bg-background/40 px-2 py-1 text-xs">
                <span className="font-bold" style={{ color: SYMS[symbol]?.color ?? "#c0c4cf" }}>{symbol}</span>
                <span className="flex items-center gap-1">
                  <input type="number" min={0} max={300} step={1} value={weights[symbol] ?? 0} aria-label={`${symbol} weight percent`}
                    onChange={(event) => setWeights((current) => ({ ...current, [symbol]: Math.max(0, Math.min(300, Number(event.target.value) || 0)) }))}
                    className="w-14 rounded border border-border bg-card px-1 py-0.5 text-right font-mono text-foreground" />
                  <span className="text-muted-foreground">%</span>
                </span>
              </label>
            ))}
          </div>
          <div className={`mt-3 text-xs ${investedPct > 100 ? "text-yellow-300" : "text-muted-foreground"}`}>
            Invested {investedPct.toFixed(0)}% · Cash {Math.max(0, 100 - investedPct).toFixed(0)}%
            {investedPct > 100 && " · Above 100% means borrowed exposure; losses can exceed the cash buffer."}
          </div>
        </Panel>

        <Panel title="Assumptions" icon={<Calculator className="h-4 w-4" />} subtitle="Every input is visible, and the sensitivity section shows how much each one matters.">
          <div className="grid gap-3 text-xs sm:grid-cols-2">
            <Field label="Horizon">
              <select value={assumptions.horizonDays} onChange={(event) => setAssumption("horizonDays", Number(event.target.value))} className="w-full rounded-md border border-border bg-background px-2 py-1.5">
                {[7, 14, 30, 90, 180].map((days) => <option key={days} value={days}>{days} days</option>)}
              </select>
            </Field>
            <Field label="History used">
              <select value={lookback} onChange={(event) => setLookback(Number(event.target.value))} className="w-full rounded-md border border-border bg-background px-2 py-1.5">
                <option value={180}>Last 180 days</option>
                <option value={365}>Last 365 days</option>
              </select>
            </Field>
            <Field label="Drift (expected trend)">
              <select value={assumptions.driftMode} onChange={(event) => setAssumption("driftMode", event.target.value as Assumptions["driftMode"])} className="w-full rounded-md border border-border bg-background px-2 py-1.5">
                <option value="neutral">Neutral: assume no edge</option>
                <option value="historical">Historical: half of past trend, capped</option>
              </select>
            </Field>
            <Field label="Tail thickness">
              <select value={assumptions.tailDf} onChange={(event) => setAssumption("tailDf", Number(event.target.value))} className="w-full rounded-md border border-border bg-background px-2 py-1.5">
                {TAIL_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </Field>
            <Slider label="Volatility level" value={assumptions.volMultiplier} min={0.5} max={2.5} step={0.05} format={(value) => `${value.toFixed(2)}x today's`} onChange={(value) => setAssumption("volMultiplier", value)} />
            <Slider label="Correlation stress" value={assumptions.corrStress} min={0} max={1} step={0.05} format={(value) => (value === 0 ? "None" : `${Math.round(value * 100)}% toward crisis`)} onChange={(value) => setAssumption("corrStress", value)} />
            <Slider label="Position size" value={assumptions.exposure} min={0} max={2} step={0.05} format={(value) => `${value.toFixed(2)}x weights`} onChange={(value) => setAssumption("exposure", value)} />
            <div>
              <label className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                <input type="checkbox" checked={assumptions.btcView != null} onChange={(event) => setAssumption("btcView", event.target.checked ? 0 : null)} className="accent-primary" />
                BTC view (median move)
              </label>
              {assumptions.btcView != null && (
                <input type="range" min={-50} max={50} step={1} value={assumptions.btcView} onChange={(event) => setAssumption("btcView", Number(event.target.value))} className="mt-2 w-full accent-primary" aria-label="BTC median move over horizon" />
              )}
              <div className="mt-1 font-mono text-foreground">{assumptions.btcView == null ? "No view (uses drift setting)" : `${assumptions.btcView > 0 ? "+" : ""}${assumptions.btcView}% over ${assumptions.horizonDays}d; alts follow by beta`}</div>
            </div>
            <Field label="Simulated paths">
              <div className="flex gap-2">
                <select value={assumptions.paths} onChange={(event) => setAssumption("paths", Number(event.target.value))} className="w-full rounded-md border border-border bg-background px-2 py-1.5">
                  {[2000, 5000, 10000, 20000].map((paths) => <option key={paths} value={paths}>{paths.toLocaleString()}</option>)}
                </select>
                <button type="button" title="Draw a new random seed" onClick={() => setAssumption("seed", Math.floor(Math.random() * 1e9))} className="rounded-md border border-border px-2 text-muted-foreground hover:text-foreground"><Shuffle className="h-4 w-4" /></button>
              </div>
            </Field>
          </div>
        </Panel>
      </div>

      {results == null ? (
        <div className="flex min-h-[200px] items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Simulating…</div>
      ) : "error" in results ? (
        <div className="rounded-xl border border-yellow-500/30 bg-yellow-500/5 p-4 text-sm text-yellow-200">{results.error}</div>
      ) : (
        <ResultsView results={results} portfolioValue={portfolioValue} computing={computing} metric={metric} setMetric={setMetric}
          tableX={tableX} tableY={tableY} setTableX={setTableX} setTableY={setTableY}
          probabilities={probabilities} setProbabilities={setProbabilities} />
      )}
    </Shell>
  );
}

function ResultsView({
  results, portfolioValue, computing, metric, setMetric, tableX, tableY, setTableX, setTableY, probabilities, setProbabilities,
}: {
  results: Results;
  portfolioValue: number;
  computing: boolean;
  metric: SensitivityMetric;
  setMetric: (metric: SensitivityMetric) => void;
  tableX: string;
  tableY: string;
  setTableX: (id: string) => void;
  setTableY: (id: string) => void;
  probabilities: Record<string, number>;
  setProbabilities: (update: (current: Record<string, number>) => Record<string, number>) => void;
}) {
  const { mc, fan, scenario, strategies, sensitivity, table, model, params, contributions, backtest } = results;
  const s = mc.summary;
  const money = (fraction: number) => usd(fraction * portfolioValue);
  const fanData = fan.bands.map((band) => ({ day: band.day, outer: [band.p5, band.p95], inner: [band.p25, band.p75], median: band.p50 }));
  const histogram = mc.histogram.map((bin) => ({ mid: bin.mid, share: bin.share }));
  const totalProbability = results.scenarios.reduce((sum, item) => sum + Math.max(0, item.probability), 0) || 1;
  const bestStrategy = strategies.reduce((best, item) => (item.returnPerRisk > best.returnPerRisk ? item : best), strategies[0]);

  return (
    <div className={`space-y-5 transition-opacity ${computing ? "opacity-60" : ""}`}>
      <section className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
        <Kpi label="Expected return" value={pct(s.mean)} detail={`${money(s.mean)} · ±${pct(1.96 * s.standardError, 2, false)} sampling error`} tone={s.mean >= 0 ? "good" : "bad"} />
        <Kpi label="Median outcome" value={pct(s.median)} detail={money(s.median)} tone={s.median >= 0 ? "good" : "bad"} />
        <Kpi label="90% interval" value={`${pct(s.ci90[0], 0)} to ${pct(s.ci90[1], 0)}`} detail="9 in 10 simulated outcomes" />
        <Kpi label="95% interval" value={`${pct(s.ci95[0], 0)} to ${pct(s.ci95[1], 0)}`} detail="19 in 20 simulated outcomes" />
        <Kpi label="95% VaR" value={money(-s.var95)} detail={`${pct(s.var95, 1, false)} loss, exceeded 1 in 20`} tone="bad" />
        <Kpi label="99% VaR" value={money(-s.var99)} detail={`${pct(s.var99, 1, false)} loss, exceeded 1 in 100`} tone="bad" />
        <Kpi label="95% CVaR" value={money(-s.cvar95)} detail="Average loss in the worst 5%" tone="bad" />
        <Kpi label="Chance of loss" value={pct(s.probLoss, 0, false)} detail={`${pct(s.probLossOver10, 0, false)} chance of losing over 10%`} />
        <Kpi label="Chance of +10%" value={pct(s.probGainOver10, 0, false)} detail="Gain above 10% at horizon" />
        <Kpi label="Median drawdown" value={pct(-fan.maxDrawdown.median, 1)} detail="Worst peak-to-trough along the path" tone="bad" />
        <Kpi label="Bad-case drawdown" value={pct(-fan.maxDrawdown.p95, 1)} detail={`${pct(fan.maxDrawdown.probOver20, 0, false)} chance of a 20%+ drawdown`} tone="bad" />
        <Kpi label="Simulation" value={`${s.n.toLocaleString()} paths`} detail={`${model.symbols.length} assets · ${results.elapsedMs.toFixed(0)} ms in browser`} />
      </section>

      <div className="grid gap-5 xl:grid-cols-2">
        <Panel title="Monte Carlo fan" icon={<Dice5 className="h-4 w-4" />} subtitle={`Portfolio return by day. Dark band: middle 50%. Light band: 90% of paths. Horizon ${params.horizonDays} days.`}>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={fanData} margin={{ top: 8, right: 12, left: -8, bottom: 0 }}>
                <CartesianGrid stroke="#12161e" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="day" tick={{ fill: "#6a7080", fontSize: 10 }} tickLine={false} axisLine={false} tickFormatter={(value) => `d${value}`} />
                <YAxis tickFormatter={(value) => pct(Number(value), 0)} tick={{ fill: "#6a7080", fontSize: 10 }} tickLine={false} axisLine={false} width={52} />
                <ReferenceLine y={0} stroke="#3a3e4a" />
                <Tooltip content={({ active, payload, label }) => {
                  if (!active || !payload?.length) return null;
                  const row = payload[0].payload as (typeof fanData)[number];
                  return <ChartTip title={`Day ${label}`} rows={[["95th pct", pct(row.outer[1])], ["75th pct", pct(row.inner[1])], ["Median", pct(row.median)], ["25th pct", pct(row.inner[0])], ["5th pct", pct(row.outer[0])]]} />;
                }} />
                <Area dataKey="outer" stroke="none" fill="#00ff87" fillOpacity={0.1} isAnimationActive={false} />
                <Area dataKey="inner" stroke="none" fill="#00ff87" fillOpacity={0.22} isAnimationActive={false} />
                <Line dataKey="median" stroke="#00ff87" dot={false} strokeWidth={2} isAnimationActive={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </Panel>
        <Panel title="Return distribution" icon={<Target className="h-4 w-4" />} subtitle="Horizon returns across all paths. The dashed line marks the 95% VaR.">
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={histogram} margin={{ top: 8, right: 12, left: -8, bottom: 0 }} barCategoryGap={1}>
                <CartesianGrid stroke="#12161e" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="mid" type="number" domain={["dataMin", "dataMax"]} tickFormatter={(value) => pct(Number(value), 0)} tick={{ fill: "#6a7080", fontSize: 10 }} tickLine={false} axisLine={false} />
                <YAxis tickFormatter={(value) => pct(Number(value), 0, false)} tick={{ fill: "#6a7080", fontSize: 10 }} tickLine={false} axisLine={false} width={44} />
                <Tooltip content={({ active, payload }) => {
                  if (!active || !payload?.length) return null;
                  const row = payload[0].payload as (typeof histogram)[number];
                  return <ChartTip title={`Return near ${pct(row.mid)}`} rows={[["Share of paths", pct(row.share, 1, false)]]} />;
                }} />
                <ReferenceLine x={-s.var95} stroke="#ff3b3b" strokeDasharray="4 3" />
                <Bar dataKey="share" isAnimationActive={false}>
                  {histogram.map((bin, index) => <Cell key={index} fill={bin.mid < -s.var95 ? "#ff3b3b" : bin.mid < 0 ? "#ff3b3b88" : "#00ff8788"} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Panel>
      </div>

      <Panel title="Scenario planning" icon={<FlaskConical className="h-4 w-4" />} subtitle="Four environments with the spread of BTC's own history over this horizon, centered on the same BTC assumption as the simulation and weighted by the current trend regime. Edit the probabilities to test your own view; they are rescaled to 100%.">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-xs">
            <thead className="text-[10px] uppercase tracking-wider text-muted-foreground">
              <tr><th className="py-2 pr-3">Scenario</th><th className="px-2 text-right">BTC move</th><th className="px-2 text-right">Alt beta</th><th className="px-2 text-right">Vol</th><th className="px-2 text-right">Corr stress</th><th className="px-2 text-right">Probability</th><th className="px-2 text-right">Expected</th><th className="px-2 text-right">95% VaR</th><th className="px-2 text-right">Weighted</th></tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {scenario.scenarios.map(({ scenario: item, weight, summary }) => (
                <tr key={item.id}>
                  <td className="py-2 pr-3"><div className="font-semibold text-foreground">{item.name}</div><div className="text-[10px] text-muted-foreground">{item.description}</div></td>
                  <td className="px-2 text-right font-mono">{pct(item.btcMove, 0)}</td>
                  <td className="px-2 text-right font-mono">{item.altBeta.toFixed(1)}x</td>
                  <td className="px-2 text-right font-mono">{item.volMultiplier.toFixed(1)}x</td>
                  <td className="px-2 text-right font-mono">{item.corrStress.toFixed(1)}</td>
                  <td className="px-2 text-right">
                    <input type="number" min={0} max={100} step={1} aria-label={`${item.name} probability`}
                      value={probabilities[item.id] ?? Math.round((item.probability / totalProbability) * 100)}
                      onChange={(event) => { const value = Math.max(0, Math.min(100, Number(event.target.value) || 0)); setProbabilities((current) => ({ ...current, [item.id]: value })); }}
                      className="w-16 rounded border border-border bg-background px-1 py-0.5 text-right font-mono" />
                    <div className="text-[10px] text-muted-foreground">{pct(weight, 0, false)} used</div>
                  </td>
                  <td className={`px-2 text-right font-mono ${summary.mean >= 0 ? "text-primary" : "text-destructive"}`}>{pct(summary.mean)}</td>
                  <td className="px-2 text-right font-mono text-destructive">{pct(summary.var95, 1, false)}</td>
                  <td className="px-2 text-right font-mono">{pct(weight * summary.mean, 2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-4">
          <Kpi label="Probability-weighted EV" value={pct(scenario.expectedReturn)} detail={money(scenario.expectedReturn)} tone={scenario.expectedReturn >= 0 ? "good" : "bad"} />
          <Kpi label="Blended 95% VaR" value={money(-scenario.mixture.var95)} detail={`${pct(scenario.mixture.var95, 1, false)} loss`} tone="bad" />
          <Kpi label="Blended 95% CVaR" value={money(-scenario.mixture.cvar95)} detail="Average of the worst 5%" tone="bad" />
          <Kpi label="Blended 90% interval" value={`${pct(scenario.mixture.ci90[0], 0)} to ${pct(scenario.mixture.ci90[1], 0)}`} detail="Across the scenario mix" />
        </div>
        {Object.keys(probabilities).length > 0 && <button type="button" className="mt-3 text-xs text-primary underline" onClick={() => setProbabilities(() => ({}))}>Reset to calibrated probabilities</button>}
      </Panel>

      <Panel title="Strategic alternatives" icon={<Scale className="h-4 w-4" />} subtitle="Each alternative runs through the same scenario mix, so the comparison isolates the allocation decision.">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-xs">
            <thead className="text-[10px] uppercase tracking-wider text-muted-foreground"><tr><th className="py-2 pr-3">Allocation</th><th className="px-2 text-right">Expected</th><th className="px-2 text-right">Median</th><th className="px-2 text-right">95% VaR</th><th className="px-2 text-right">95% CVaR</th><th className="px-2 text-right">Chance of loss</th><th className="px-2 text-right">Return per unit of tail risk</th></tr></thead>
            <tbody className="divide-y divide-border/60">
              {strategies.map((item) => (
                <tr key={item.strategy.id} className={item === bestStrategy ? "bg-primary/[0.04]" : ""}>
                  <td className="py-2 pr-3"><div className="font-semibold text-foreground">{item.strategy.name}{item === bestStrategy && <span className="ml-2 rounded bg-primary/15 px-1.5 py-0.5 text-[9px] text-primary">best ratio</span>}</div><div className="text-[10px] text-muted-foreground">{item.strategy.description}</div></td>
                  <td className={`px-2 text-right font-mono ${item.expectedReturn >= 0 ? "text-primary" : "text-destructive"}`}>{pct(item.expectedReturn)}</td>
                  <td className="px-2 text-right font-mono">{pct(item.median)}</td>
                  <td className="px-2 text-right font-mono text-destructive">{pct(item.var95, 1, false)}</td>
                  <td className="px-2 text-right font-mono text-destructive">{pct(item.cvar95, 1, false)}</td>
                  <td className="px-2 text-right font-mono">{pct(item.probLoss, 0, false)}</td>
                  <td className="px-2 text-right font-mono">{item.returnPerRisk.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[10px] text-muted-foreground">Under neutral drift every allocation has an expected return near zero, so the useful comparison is tail risk. Switch drift or set a BTC view to compare return trade-offs.</p>
      </Panel>

      <Panel title="Sensitivity analysis" icon={<Target className="h-4 w-4" />} subtitle="Each assumption is moved to a low and a high value while all others stay fixed. Bars show how far the chosen result moves. Every run reuses the same random draws, so differences come from the assumption, not from noise.">
        <div className="mb-4 flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted-foreground">Result to test</span>
          {METRICS.map((item) => <button key={item} type="button" onClick={() => setMetric(item)} aria-pressed={metric === item} className={`rounded-md border px-2 py-1 ${metric === item ? "border-primary/50 bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground"}`}>{SENSITIVITY_METRIC_LABELS[item]}</button>)}
        </div>
        <Tornado result={sensitivity} drivers={results.drivers} />
        <div className="mt-4 rounded-lg border border-primary/20 bg-primary/[0.04] p-3 text-xs">
          <span className="font-semibold text-foreground">Critical value drivers: </span>
          <span className="text-muted-foreground">{sensitivity.critical.map((id) => results.drivers.find((driver) => driver.id === id)?.label ?? id).join(", ")} explain at least 80% of the total variation in {SENSITIVITY_METRIC_LABELS[sensitivity.metric].toLowerCase()}. Focus research and position sizing on these.</span>
        </div>
      </Panel>

      <Panel title="Two-variable data table" icon={<Calculator className="h-4 w-4" />} subtitle={`${SENSITIVITY_METRIC_LABELS[metric]} for every combination of two assumptions.`}>
        <div className="mb-3 flex flex-wrap gap-3 text-xs">
          <label className="flex items-center gap-2 text-muted-foreground">Columns
            <select value={tableX} onChange={(event) => setTableX(event.target.value)} className="rounded-md border border-border bg-background px-2 py-1 text-foreground">{results.drivers.map((driver) => <option key={driver.id} value={driver.id}>{driver.label}</option>)}</select>
          </label>
          <label className="flex items-center gap-2 text-muted-foreground">Rows
            <select value={tableY} onChange={(event) => setTableY(event.target.value)} className="rounded-md border border-border bg-background px-2 py-1 text-foreground">{results.drivers.map((driver) => <option key={driver.id} value={driver.id}>{driver.label}</option>)}</select>
          </label>
        </div>
        {table && results.tableX && results.tableY ? <DataTableView table={table} x={results.tableX} y={results.tableY} /> : <p className="text-xs text-muted-foreground">Choose two different assumptions.</p>}
      </Panel>

      <div className="grid gap-5 xl:grid-cols-3">
        <Panel title="Correlation (180 days, shrunk)" icon={<Info className="h-4 w-4" />} subtitle={`Average pairwise correlation ${model.averageCorrelation.toFixed(2)}.`}>
          <Heatmap symbols={model.symbols} matrix={model.correlation} />
        </Panel>
        <Panel title="Where the risk comes from" icon={<Info className="h-4 w-4" />} subtitle="Share of portfolio variance from each holding. Compare it with the weight to spot concentrated risk.">
          <div className="space-y-2 text-xs">
            {model.symbols.map((symbol, index) => ({ symbol, weight: params.weights[index] * params.exposure, share: contributions[index] }))
              .filter((row) => row.weight > 0).sort((a, b) => b.share - a.share).map((row) => (
                <div key={row.symbol}>
                  <div className="flex justify-between"><span className="font-semibold" style={{ color: SYMS[row.symbol]?.color }}>{row.symbol}</span><span className="font-mono text-muted-foreground">weight {pct(row.weight, 0, false)} · risk {pct(row.share, 0, false)}</span></div>
                  <div className="mt-1 h-1.5 rounded bg-muted"><div className="h-1.5 rounded bg-primary" style={{ width: `${Math.max(0, Math.min(100, row.share * 100))}%` }} /></div>
                </div>
              ))}
          </div>
        </Panel>
        <Panel title="Does the risk model hold up?" icon={<Info className="h-4 w-4" />} subtitle="Kupiec test of a rolling 1-day 95% VaR on this portfolio's own history.">
          <div className="space-y-2 text-xs">
            <div className={`text-lg font-bold ${backtest.verdict === "calibrated" ? "text-primary" : backtest.verdict === "insufficient data" ? "text-muted-foreground" : "text-yellow-300"}`}>{backtest.verdict === "calibrated" ? "Calibrated" : backtest.verdict === "underestimates risk" ? "Underestimates risk" : backtest.verdict === "overestimates risk" ? "Overestimates risk" : "Insufficient data"}</div>
            <p className="text-muted-foreground">{backtest.exceptions} breaches in {backtest.tested} days versus {backtest.expected.toFixed(1)} expected (p = {backtest.pValue.toFixed(2)}).</p>
            <p className="text-muted-foreground">{backtest.verdict === "underestimates risk" ? "Losses beyond VaR happened more often than promised. Treat the VaR above as optimistic and consider fatter tails or higher volatility." : backtest.verdict === "calibrated" ? "Breaches occurred about as often as a 95% VaR should allow." : backtest.verdict === "overestimates risk" ? "Breaches were rarer than expected; the model is conservative for this mix." : "Needs at least 60 testable days."}</p>
          </div>
        </Panel>
      </div>

      <details className="rounded-xl border border-border bg-background/30 p-4 text-xs text-muted-foreground">
        <summary className="cursor-pointer font-semibold text-foreground">Method and limits</summary>
        <ul className="mt-3 list-disc space-y-1 pl-5 leading-relaxed">
          <li>Volatility is the RiskMetrics exponentially weighted estimate (lambda 0.94), so recent moves count more than old ones.</li>
          <li>Correlations use 180 days of daily returns, shrunk 15% toward the average to reduce estimation noise. Correlation stress blends toward a 0.9 crisis matrix.</li>
          <li>Fat tails come from a per-path volatility regime (a multivariate Student-t), so in bad paths every asset falls together, as in real crypto sell-offs.</li>
          <li>Neutral drift assumes no expected gain or loss. Historical drift uses half the past trend, capped at 0.4% per day, because past returns are a weak guide.</li>
          <li>Scenario moves are percentiles of BTC's rolling returns over this horizon, re-centered on the simulation's BTC assumption so a strong past year is not quietly assumed to repeat. Alts follow through their measured beta to BTC.</li>
          <li>All results are model estimates from recent history. They are not forecasts or investment advice, and liquidity, fees, and slippage are not modeled.</li>
        </ul>
      </details>
    </div>
  );
}

function Shell({ children, asOf, lookback, excluded }: { children: ReactNode; asOf?: string; lookback?: number; excluded?: RiskLabModel["excluded"] }) {
  return (
    <div className="animate-fade-up space-y-5">
      <section className="rounded-xl border border-primary/20 bg-card p-5">
        <div className="flex items-center gap-2 text-primary"><Dice5 className="h-4 w-4" /><span className="text-[10px] font-semibold uppercase tracking-[0.22em]">Portfolio risk lab</span></div>
        <h1 className="mt-2 font-display text-3xl font-black text-foreground">RISK LAB</h1>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">Monte Carlo simulation, scenario planning, and sensitivity analysis for your own mix, calibrated to daily market history. Everything runs in your browser; nothing about your portfolio is sent to the server.</p>
        {asOf && <p className="mt-2 text-[10px] text-muted-foreground">Data through {asOf} · {lookback} days of history{excluded?.length ? ` · Not available: ${excluded.map((item) => item.symbol).join(", ")}` : ""}</p>}
      </section>
      {children}
    </div>
  );
}

function Panel({ title, subtitle, icon, children }: { title: string; subtitle?: string; icon?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
      <div className="mb-4">
        <h2 className="flex items-center gap-2 font-display text-lg font-black text-foreground"><span className="text-primary">{icon}</span>{title}</h2>
        {subtitle && <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{subtitle}</p>}
      </div>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block"><span className="mb-1 block text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">{label}</span>{children}</label>;
}

function Slider({ label, value, min, max, step, format, onChange }: { label: string; value: number; min: number; max: number; step: number; format: (value: number) => string; onChange: (value: number) => void }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} className="w-full accent-primary" aria-label={label} />
      <span className="font-mono text-foreground">{format(value)}</span>
    </label>
  );
}

function Kpi({ label, value, detail, tone }: { label: string; value: string; detail?: string; tone?: "good" | "bad" }) {
  return (
    <div className="rounded-lg border border-border/70 bg-background/35 p-3">
      <div className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">{label}</div>
      <div className={`mt-1 font-mono text-base font-bold ${tone === "good" ? "text-primary" : tone === "bad" ? "text-destructive" : "text-foreground"}`}>{value}</div>
      {detail && <div className="mt-1 text-[10px] leading-relaxed text-muted-foreground">{detail}</div>}
    </div>
  );
}

function ChartTip({ title, rows }: { title: string; rows: Array<[string, string]> }) {
  return (
    <div className="rounded-lg border border-border bg-[#080a10]/95 p-3 text-xs shadow-xl">
      <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">{title}</div>
      {rows.map(([name, value]) => <div key={name} className="flex justify-between gap-4"><span className="text-muted-foreground">{name}</span><span className="font-mono text-foreground">{value}</span></div>)}
    </div>
  );
}

function Tornado({ result, drivers }: { result: ReturnType<typeof runSensitivity>; drivers: SensitivityDriver[] }) {
  const span = Math.max(1e-9, ...result.rows.flatMap((row) => [Math.abs(row.lowValue - result.baseValue), Math.abs(row.highValue - result.baseValue)]));
  const byId = new Map(drivers.map((driver) => [driver.id, driver]));
  return (
    <div className="space-y-1.5" role="img" aria-label={`Tornado chart of ${SENSITIVITY_METRIC_LABELS[result.metric]}`}>
      <div className="grid grid-cols-[minmax(110px,190px)_1fr] gap-2 text-[10px] text-muted-foreground sm:grid-cols-[minmax(110px,190px)_1fr_minmax(150px,210px)]">
        <span />
        <span className="text-center">Base {formatMetric(result.metric, result.baseValue)}</span>
        <span className="hidden sm:block">Low input / high input</span>
      </div>
      {result.rows.map((row) => {
        const driver = byId.get(row.id);
        const label = (input: number) => (driver ? formatDriverValue(driver, input) : String(input));
        const segments = [
          { value: row.lowValue, input: row.low, color: "#6e9eff", name: "low" },
          { value: row.highValue, input: row.high, color: "#f0b90b", name: "high" },
        ];
        return (
          <div key={row.id} className="grid grid-cols-[minmax(110px,190px)_1fr] items-center gap-2 text-[11px] sm:grid-cols-[minmax(110px,190px)_1fr_minmax(150px,210px)]">
            <div className="truncate text-right text-foreground" title={row.label}>{row.label}{result.critical.includes(row.id) && <span className="ml-1 text-primary">●</span>}</div>
            <div className="relative h-6 rounded bg-background/40">
              <div className="absolute inset-y-0 left-1/2 w-px bg-border" />
              {segments.map((segment) => {
                const delta = segment.value - result.baseValue;
                const width = (Math.abs(delta) / span) * 50;
                return (
                  <div key={segment.name} className="absolute top-1 h-4 rounded-sm opacity-90" title={`${label(segment.input)}: ${formatMetric(result.metric, segment.value)}`}
                    style={{ backgroundColor: segment.color, width: `${width}%`, left: delta >= 0 ? "50%" : `${50 - width}%` }} />
                );
              })}
            </div>
            <div className="hidden font-mono text-[10px] text-muted-foreground sm:block">
              <span className="text-[#6e9eff]">{label(row.low)}</span> {formatMetric(result.metric, row.lowValue)} / <span className="text-[#f0b90b]">{label(row.high)}</span> {formatMetric(result.metric, row.highValue)}
            </div>
          </div>
        );
      })}
      <div className="flex flex-wrap gap-4 pt-1 text-[10px] text-muted-foreground">
        <span className="flex items-center gap-1"><span className="h-2 w-3 rounded-sm bg-[#6e9eff]" />Low input</span>
        <span className="flex items-center gap-1"><span className="h-2 w-3 rounded-sm bg-[#f0b90b]" />High input</span>
        <span className="flex items-center gap-1"><span className="text-primary">●</span>Critical driver</span>
      </div>
    </div>
  );
}

function DataTableView({ table, x, y }: { table: ReturnType<typeof runDataTable>; x: SensitivityDriver; y: SensitivityDriver }) {
  const values = table.grid.flat();
  const min = Math.min(...values);
  const max = Math.max(...values);
  const worseIsHigher = table.metric === "var95" || table.metric === "cvar95" || table.metric === "probLoss";
  const shade = (value: number) => {
    const t = max > min ? (value - min) / (max - min) : 0.5;
    const bad = worseIsHigher ? t : 1 - t;
    return bad > 0.5 ? `rgba(255,59,59,${(bad - 0.5) * 0.7})` : `rgba(0,255,135,${(0.5 - bad) * 0.5})`;
  };
  return (
    <div className="overflow-x-auto">
      <table className="text-xs">
        <thead>
          <tr><th className="p-2 text-left text-[10px] font-normal text-muted-foreground">{y.label} ↓ / {x.label} →</th>{table.xValues.map((value) => <th key={value} className="p-2 text-right font-mono font-semibold text-foreground">{formatDriverValue(x, value)}</th>)}</tr>
        </thead>
        <tbody>
          {table.yValues.map((yValue, row) => (
            <tr key={yValue}>
              <th className="p-2 text-left font-mono font-semibold text-foreground">{formatDriverValue(y, yValue)}</th>
              {table.grid[row].map((value, column) => <td key={column} className="p-2 text-right font-mono" style={{ backgroundColor: shade(value) }}>{formatMetric(table.metric, value)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Heatmap({ symbols, matrix }: { symbols: string[]; matrix: number[][] }) {
  return (
    <div className="overflow-x-auto">
      <table className="text-[10px]">
        <thead><tr><th />{symbols.map((symbol) => <th key={symbol} className="px-1 py-1 font-semibold text-muted-foreground">{symbol}</th>)}</tr></thead>
        <tbody>
          {symbols.map((rowSymbol, i) => (
            <tr key={rowSymbol}>
              <th className="pr-2 text-right font-semibold text-muted-foreground">{rowSymbol}</th>
              {symbols.map((columnSymbol, j) => {
                const value = matrix[i][j];
                return <td key={columnSymbol} className="h-7 w-9 text-center font-mono" style={{ backgroundColor: value >= 0 ? `rgba(0,255,135,${value * 0.55})` : `rgba(110,158,255,${-value * 0.55})` }}>{i === j ? "" : value.toFixed(2)}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
