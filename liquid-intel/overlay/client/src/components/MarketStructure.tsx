import { useMemo, useState, type ReactNode } from "react";
import { Activity, AlertTriangle, ArrowDownRight, ArrowUpRight, Droplets, FlaskConical, Gauge, Layers, Loader2, Radar } from "lucide-react";
import type { AssetStructure, Insight, MarketStructure as Structure, SignalValidation } from "@shared/quant/structure";
import { SYMS, fmtPrice } from "@/lib/crypto-utils";
import { historyFromError, pct, usd, useMarketStructure } from "@/lib/quant-api";

type SortKey = "composite" | "ret7d" | "ret30d" | "ret90d" | "vol30" | "dist200" | "relStrength30" | "drawdown365" | "volumeZ";

const TONE: Record<Insight["tone"], string> = {
  bull: "border-primary/30 bg-primary/[0.05] text-primary",
  bear: "border-destructive/30 bg-destructive/[0.05] text-destructive",
  neutral: "border-border bg-background/40 text-foreground",
  alert: "border-yellow-400/30 bg-yellow-400/[0.05] text-yellow-200",
};

const VERDICT: Record<SignalValidation["verdict"], { label: string; className: string }> = {
  predictive: { label: "Predictive", className: "text-primary" },
  weak: { label: "Weak edge", className: "text-yellow-300" },
  none: { label: "No reliable edge", className: "text-muted-foreground" },
  "insufficient data": { label: "Not enough history", className: "text-muted-foreground" },
};

export function MarketStructure({ onSelectAsset }: { onSelectAsset?: (symbol: string) => void }) {
  const query = useMarketStructure();
  const [sort, setSort] = useState<{ key: SortKey; descending: boolean }>({ key: "composite", descending: true });
  const structure = query.data?.structure;
  const assets = useMemo(() => {
    if (!structure) return [];
    return [...structure.assets].sort((a, b) => {
      const left = a[sort.key] ?? -Infinity;
      const right = b[sort.key] ?? -Infinity;
      return sort.descending ? Number(right) - Number(left) : Number(left) - Number(right);
    });
  }, [structure, sort]);

  if (query.isLoading) return <Frame><div className="flex min-h-[260px] items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading daily market structure…</div></Frame>;
  if (query.error || !structure) {
    const history = historyFromError(query.error);
    return (
      <Frame>
        <div className="rounded-xl border border-yellow-500/30 bg-yellow-500/5 p-5 text-sm text-yellow-200">
          <div className="flex items-center gap-2 font-semibold"><AlertTriangle className="h-4 w-4" />{query.error instanceof Error ? query.error.message : "Market structure is unavailable."}</div>
          {history && <p className="mt-2 text-xs text-yellow-100/80">{history.assets.filter((row) => row.points > 0).length}/{history.assets.length} assets have daily history so far. This page retries automatically.</p>}
        </div>
      </Frame>
    );
  }

  const { regime, breadth, correlation, liquidity, validation, insights } = structure;
  const chooseSort = (key: SortKey) => setSort((current) => ({ key, descending: current.key === key ? !current.descending : true }));

  return (
    <Frame asOf={structure.asOf} regime={regime.label} trend={regime.trend}>
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat icon={<Gauge className="h-4 w-4" />} label="Regime" value={regime.label} detail={regime.btcVol30 != null ? `BTC 30d volatility ${pct(regime.btcVol30, 0, false)} annualized${regime.btcVolPercentile != null ? `, ${Math.round(regime.btcVolPercentile * 100)}th percentile of the year` : ""}` : "BTC versus its 50- and 200-day averages"} />
        <Stat icon={<Layers className="h-4 w-4" />} label="Breadth" value={breadth.above50 != null ? `${Math.round(breadth.above50 * 100)}% above 50d` : "—"} detail={`${breadth.above200 != null ? `${Math.round(breadth.above200 * 100)}% above 200d` : "200d n/a"} · ${breadth.advancing7d != null ? `${Math.round(breadth.advancing7d * 100)}% up over 7d` : "7d n/a"}`} />
        <Stat icon={<Activity className="h-4 w-4" />} label="Correlation" value={correlation.average30 != null ? correlation.average30.toFixed(2) : "—"} detail={correlation.average30 != null && correlation.average30 >= 0.7 ? "Assets move as one; diversification is weak" : `30d average pairwise${correlation.dispersion30 != null ? ` · 30d return dispersion ${pct(correlation.dispersion30, 0, false)}` : ""}`} />
        <Stat icon={<Droplets className="h-4 w-4" />} label="Stablecoin liquidity" value={liquidity.stablecoinChange30dPct != null ? `${pct(liquidity.stablecoinChange30dPct, 2)} in 30d` : "—"} detail={`${liquidity.stablecoinSupply != null ? `${usd(liquidity.stablecoinSupply)} supply` : "supply n/a"}${liquidity.stablecoinImpulseZ != null ? ` · ${liquidity.stablecoinImpulseZ >= 0 ? "+" : ""}${liquidity.stablecoinImpulseZ.toFixed(1)} sd vs 1-year norm` : ""}`} />
        <Stat label="DeFi TVL" value={liquidity.tvlChange30dPct != null ? `${pct(liquidity.tvlChange30dPct, 1)} in 30d` : "—"} detail="Moves with token prices; compare with the market" />
        <Stat label="DEX activity" value={liquidity.dexVolumeRatio7v30 != null ? `${liquidity.dexVolumeRatio7v30.toFixed(2)}x` : "—"} detail="7-day average volume versus 30-day average" />
        <Stat label="Fear and Greed" value={liquidity.fearGreed != null ? String(Math.round(liquidity.fearGreed)) : "—"} detail={liquidity.fearGreedChange7d != null ? `${liquidity.fearGreedChange7d >= 0 ? "+" : ""}${Math.round(liquidity.fearGreedChange7d)} over 7 days (alternative.me)` : "alternative.me index"} />
        <Stat label="Stablecoin evidence" value={liquidity.conditional ? pct(liquidity.conditional.avgForward30) : "—"} detail={liquidity.conditional ? `Avg BTC 30d return after ${liquidity.conditional.condition} (n=${liquidity.conditional.n}) vs ${pct(liquidity.conditional.baseline30)} on all days` : "Not enough comparable history"} />
      </section>

      {insights.length > 0 && (
        <section className="grid gap-3 md:grid-cols-2">
          {insights.map((insight) => (
            <article key={insight.id} className={`rounded-xl border p-4 ${TONE[insight.tone]}`}>
              <h3 className="text-sm font-bold">{insight.title}</h3>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{insight.detail}</p>
            </article>
          ))}
        </section>
      )}

      <section className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <div className="border-b border-border p-4">
          <h2 className="flex items-center gap-2 font-display text-lg font-black text-foreground"><Radar className="h-4 w-4 text-primary" />Trend strength by asset</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">The score runs from -100 to +100. It blends distance from the 50- and 200-day averages in volatility units (35%), risk-adjusted 30- and 90-day momentum (35%), 30-day strength versus BTC (20%), and whether volume confirms the move (10%). Volatility scaling makes a quiet and a volatile asset comparable.</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] whitespace-nowrap text-left text-xs">
            <thead className="bg-muted/40 text-[10px] uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-3 py-2">Asset</th>
                <SortHeader label="Score" active={sort.key === "composite"} descending={sort.descending} onClick={() => chooseSort("composite")} />
                <th className="px-3 py-2">Read</th>
                <SortHeader label="7d" active={sort.key === "ret7d"} descending={sort.descending} onClick={() => chooseSort("ret7d")} />
                <SortHeader label="30d" active={sort.key === "ret30d"} descending={sort.descending} onClick={() => chooseSort("ret30d")} />
                <SortHeader label="90d" active={sort.key === "ret90d"} descending={sort.descending} onClick={() => chooseSort("ret90d")} />
                <SortHeader label="vs BTC 30d" active={sort.key === "relStrength30"} descending={sort.descending} onClick={() => chooseSort("relStrength30")} />
                <SortHeader label="vs 200d avg" active={sort.key === "dist200"} descending={sort.descending} onClick={() => chooseSort("dist200")} />
                <SortHeader label="Vol 30d" active={sort.key === "vol30"} descending={sort.descending} onClick={() => chooseSort("vol30")} />
                <SortHeader label="From 1y high" active={sort.key === "drawdown365"} descending={sort.descending} onClick={() => chooseSort("drawdown365")} />
                <th className="px-3 py-2 text-right">RSI 14</th>
                <th className="px-3 py-2 text-right">Beta</th>
                <SortHeader label="Volume z" active={sort.key === "volumeZ"} descending={sort.descending} onClick={() => chooseSort("volumeZ")} />
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {assets.map((asset) => <AssetRow key={asset.symbol} asset={asset} onSelect={onSelectAsset} />)}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
        <h2 className="flex items-center gap-2 font-display text-lg font-black text-foreground"><FlaskConical className="h-4 w-4 text-primary" />Has this score worked?</h2>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">A walk-forward test on the loaded history. At each past date the score is computed with only the data available then, assets are ranked, and the ranking is compared with the returns that followed. A rank correlation (IC) above about 0.05 with a t-statistic above 2 is a meaningful edge. The verdict is reported as found, including when there is no edge.</p>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {validation.map((item) => (
            <div key={item.horizonDays} className="rounded-lg border border-border/70 bg-background/35 p-4 text-xs">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Next {item.horizonDays} days</span>
                <span className={`text-sm font-bold ${VERDICT[item.verdict].className}`}>{VERDICT[item.verdict].label}</span>
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-2 font-mono">
                <div><dt className="text-[10px] text-muted-foreground">Mean IC</dt><dd>{item.meanIc != null ? item.meanIc.toFixed(3) : "—"}</dd></div>
                <div><dt className="text-[10px] text-muted-foreground">t-statistic</dt><dd>{item.icTStat != null ? item.icTStat.toFixed(2) : "—"}</dd></div>
                <div><dt className="text-[10px] text-muted-foreground">Windows with IC above 0</dt><dd>{item.hitRate != null ? pct(item.hitRate, 0, false) : "—"}</dd></div>
                <div><dt className="text-[10px] text-muted-foreground">Top third minus bottom third</dt><dd>{item.topMinusBottom != null ? pct(item.topMinusBottom, 2) : "—"}</dd></div>
              </dl>
              <p className="mt-3 text-muted-foreground">{item.evaluations} non-overlapping windows. {item.note}</p>
            </div>
          ))}
        </div>
      </section>
    </Frame>
  );
}

function Frame({ children, asOf, regime, trend }: { children: ReactNode; asOf?: string | null; regime?: string; trend?: Structure["regime"]["trend"] }) {
  return (
    <div className="animate-fade-up space-y-5">
      <section className="rounded-xl border border-primary/20 bg-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-primary"><Radar className="h-4 w-4" /><span className="text-[10px] font-semibold uppercase tracking-[0.22em]">Market structure</span></div>
            <h1 className="mt-2 font-display text-3xl font-black text-foreground">SIGNALS</h1>
            <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">Trend, momentum, breadth, correlation, and liquidity from daily closes, measured in volatility-adjusted terms so moves are comparable across assets and time.</p>
          </div>
          {regime && (
            <span className={`rounded-full border px-3 py-1 text-xs font-semibold ${trend === "bull" ? "border-primary/40 bg-primary/10 text-primary" : trend === "bear" ? "border-destructive/40 bg-destructive/10 text-destructive" : "border-yellow-400/40 bg-yellow-400/10 text-yellow-200"}`}>{regime}</span>
          )}
        </div>
        {asOf && <p className="mt-2 text-[10px] text-muted-foreground">Daily closes through {asOf} (UTC). Refreshed every 6 hours.</p>}
      </section>
      {children}
    </div>
  );
}

function Stat({ label, value, detail, icon }: { label: string; value: string; detail: string; icon?: ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground"><span className="text-primary">{icon}</span>{label}</div>
      <div className="mt-1 font-display text-lg font-black text-foreground">{value}</div>
      <div className="mt-1 text-[10px] leading-relaxed text-muted-foreground">{detail}</div>
    </div>
  );
}

function SortHeader({ label, active, descending, onClick }: { label: string; active: boolean; descending: boolean; onClick: () => void }) {
  return <th className="px-3 py-2 text-right"><button type="button" onClick={onClick} className={`uppercase ${active ? "text-primary" : "hover:text-foreground"}`}>{label}{active ? (descending ? " ↓" : " ↑") : ""}</button></th>;
}

function signed(value: number | null, digits = 1) {
  return <span className={value == null ? "text-muted-foreground" : value >= 0 ? "text-primary" : "text-destructive"}>{pct(value, digits)}</span>;
}

function AssetRow({ asset, onSelect }: { asset: AssetStructure; onSelect?: (symbol: string) => void }) {
  const width = Math.min(50, Math.abs(asset.composite) / 2);
  const color = SYMS[asset.symbol]?.color ?? "#c0c4cf";
  return (
    <tr className="hover:bg-muted/40">
      <td className="px-3 py-2">
        <button type="button" onClick={() => onSelect?.(asset.symbol)} className="text-left">
          <div className="font-bold hover:underline" style={{ color }}>{asset.symbol}</div>
          <div className="text-[10px] text-muted-foreground">${fmtPrice(asset.price)}</div>
        </button>
      </td>
      <td className="px-3 py-2">
        <div className="flex items-center justify-end gap-2">
          <span className={`w-9 text-right font-mono font-bold ${asset.composite >= 0 ? "text-primary" : "text-destructive"}`}>{asset.composite.toFixed(0)}</span>
          <div className="relative h-2 w-24 rounded bg-muted" aria-hidden="true">
            <div className="absolute inset-y-0 left-1/2 w-px bg-border" />
            <div className={`absolute inset-y-0 rounded ${asset.composite >= 0 ? "bg-primary" : "bg-destructive"}`} style={{ width: `${width}%`, left: asset.composite >= 0 ? "50%" : `${50 - width}%` }} />
          </div>
        </div>
      </td>
      <td className="px-3 py-2">
        <span className="inline-flex items-center gap-1">{asset.composite >= 15 ? <ArrowUpRight className="h-3 w-3 text-primary" /> : asset.composite <= -15 ? <ArrowDownRight className="h-3 w-3 text-destructive" /> : null}{asset.label}</span>
        {asset.returnZ != null && Math.abs(asset.returnZ) >= 3 && <span className="ml-2 rounded bg-yellow-400/15 px-1 text-[9px] text-yellow-200">unusual day</span>}
      </td>
      <td className="px-3 py-2 text-right font-mono">{signed(asset.ret7d)}</td>
      <td className="px-3 py-2 text-right font-mono">{signed(asset.ret30d)}</td>
      <td className="px-3 py-2 text-right font-mono">{signed(asset.ret90d, 0)}</td>
      <td className="px-3 py-2 text-right font-mono">{signed(asset.relStrength30)}</td>
      <td className="px-3 py-2 text-right font-mono">{signed(asset.dist200)}</td>
      <td className="px-3 py-2 text-right font-mono text-muted-foreground">{asset.vol30 != null ? pct(asset.vol30, 0, false) : "—"}</td>
      <td className="px-3 py-2 text-right font-mono text-muted-foreground">{asset.drawdown365 != null ? pct(asset.drawdown365, 0) : "—"}</td>
      <td className={`px-3 py-2 text-right font-mono ${asset.rsi14 != null && (asset.rsi14 >= 70 || asset.rsi14 <= 30) ? "text-yellow-300" : "text-muted-foreground"}`}>{asset.rsi14 != null ? asset.rsi14.toFixed(0) : "—"}</td>
      <td className="px-3 py-2 text-right font-mono text-muted-foreground">{asset.beta90 != null ? asset.beta90.toFixed(2) : "—"}</td>
      <td className={`px-3 py-2 text-right font-mono ${asset.volumeZ != null && asset.volumeZ >= 2 ? "text-yellow-300" : "text-muted-foreground"}`}>{asset.volumeZ != null ? asset.volumeZ.toFixed(1) : "—"}</td>
    </tr>
  );
}
