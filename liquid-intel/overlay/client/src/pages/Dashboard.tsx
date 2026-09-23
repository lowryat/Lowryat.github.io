import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { useDashboardData } from "@/hooks/use-data";
import { fmt, fmtPrice, liveInsights, SYMS } from "@/lib/crypto-utils";
import { LoadingSplash } from "@/components/ui/LoadingSplash";
import { AlertsPanel } from "@/components/AlertsPanel";
import { AnalysisAlerts } from "@/components/AnalysisAlerts";
import { DynamicBarChart } from "@/components/Charts";
import { LongPressTile } from "@/components/LongPressTile";
import { CompareWorkspace } from "@/components/CompareWorkspace";
import { IntelligencePanel } from "@/components/IntelligencePanels";
import { BriefingOverview } from "@/components/BriefingOverview";
// Heavier analytics tabs load on first open so the overview stays fast.
const MarketStructure = lazy(() => import("@/components/MarketStructure").then((module) => ({ default: module.MarketStructure })));
const RiskLab = lazy(() => import("@/components/RiskLab").then((module) => ({ default: module.RiskLab })));
const DataHealth = lazy(() => import("@/components/DataHealth").then((module) => ({ default: module.DataHealth })));
import { trackTelemetry } from "@/lib/telemetry";
import { useMarketBriefing } from "@/hooks/use-market-briefing";
import type { HistoryRange } from "@shared/history";
import { Activity, LayoutGrid, List, Target, BellRing, AlertTriangle, BrainCircuit, TrendingUp, TrendingDown, Radar, Dice5, HeartPulse } from "lucide-react";

type TabId = "overview" | "signals" | "compare" | "detail" | "risk" | "intelligence" | "alerts" | "health";
const TAB_IDS: TabId[] = ["overview", "signals", "compare", "detail", "risk", "intelligence", "alerts", "health"];
const SPLASH_KEY = "liq-intel:splash-seen";

function splashAlreadySeen(): boolean {
  try {
    return window.sessionStorage.getItem(SPLASH_KEY) === "1";
  } catch {
    return false;
  }
}
const RANGE_IDS: HistoryRange[] = ["1h", "6h", "24h", "7d"];

export function Dashboard() {
  const { data, isLoading, error } = useDashboardData();
  const briefing = useMarketBriefing();
  // The splash plays once per browser session, not on every reload or tab switch.
  const [splash, setSplash] = useState(() => !splashAlreadySeen());
  const [tab, setTab] = useState<TabId>(() => {
    const value = new URLSearchParams(window.location.search).get("tab");
    return TAB_IDS.includes(value as TabId) ? value as TabId : "overview";
  });
  const [selectedAsset, setSelectedAsset] = useState<string>(() => new URLSearchParams(window.location.search).get("asset")?.toUpperCase() || "BTC");
  const [comparison, setComparison] = useState<string[]>(() => (new URLSearchParams(window.location.search).get("compare") || "BTC,ETH").split(",").map(value => value.trim().toUpperCase()).filter(Boolean).slice(0, 5));
  const [range, setRange] = useState<HistoryRange>(() => {
    const value = new URLSearchParams(window.location.search).get("range");
    return RANGE_IDS.includes(value as HistoryRange) ? value as HistoryRange : "24h";
  });

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    params.set("tab", tab);
    params.set("asset", selectedAsset);
    params.set("range", range);
    if (comparison.length) params.set("compare", comparison.join(","));
    else params.delete("compare");
    window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
  }, [tab, selectedAsset, comparison, range]);

  useEffect(() => {
    const onPopState = () => {
      const params = new URLSearchParams(window.location.search);
      const nextTab = params.get("tab") as TabId;
      setTab(TAB_IDS.includes(nextTab) ? nextTab : "overview");
      setSelectedAsset(params.get("asset")?.toUpperCase() || "BTC");
      const nextRange = params.get("range") as HistoryRange;
      setRange(RANGE_IDS.includes(nextRange) ? nextRange : "24h");
      setComparison((params.get("compare") || "").split(",").map(value => value.trim().toUpperCase()).filter(Boolean).slice(0, 5));
    };
    window.addEventListener("popstate", onPopState);
    const onTimelineRangeChange = (event: Event) => {
      const nextRange = (event as CustomEvent<HistoryRange>).detail;
      if (RANGE_IDS.includes(nextRange)) setRange(nextRange);
    };
    window.addEventListener("liq-intel-range-change", onTimelineRangeChange);
    return () => {
      window.removeEventListener("popstate", onPopState);
      window.removeEventListener("liq-intel-range-change", onTimelineRangeChange);
    };
  }, []);

  const assets = data?.assets || {};
  const syms = Object.keys(assets);
  const insights = useMemo(() => liveInsights(data), [data]);
  const splashIns = insights[0] || { tp: "info", ic: Activity, hl: "Loading Market Data...", dt: "", pr: 1 };
  const sourceCount = data ? Object.values(data.source).filter(Boolean).length : 0;

  const compareData = useMemo(() => {
    return syms.filter(s => SYMS[s]).map(s => {
      const a = assets[s];
      return {
        name: s,
        price: a.price,
        mcap: a.mcap,
        vol: a.vol24h,
        change1h: a.change1h,
        change24h: a.change24h,
        change7d: a.change7d,
        change30d: a.change30d,
        tvl: a.tvl,
        dexVol: a.dexVol,
        color: SYMS[s]?.color || "#5a5e6a",
        category: SYMS[s]?.cat || "Other",
      };
    }).sort((a, b) => (b.mcap ?? 0) - (a.mcap ?? 0));
  }, [assets, syms]);

  const TABS: { id: TabId; label: string; icon: any }[] = [
    { id: "overview", label: "OVERVIEW", icon: LayoutGrid },
    { id: "signals", label: "SIGNALS", icon: Radar },
    { id: "compare", label: "COMPARE", icon: List },
    { id: "detail", label: "DETAIL", icon: Target },
    { id: "risk", label: "RISK LAB", icon: Dice5 },
    { id: "intelligence", label: "INTEL", icon: BrainCircuit },
    { id: "alerts", label: "ALERTS", icon: BellRing },
    { id: "health", label: "HEALTH", icon: HeartPulse },
  ];

  return (
    <div className="flex flex-col min-h-screen">
      <div className="scanline" />
      
      {splash && <LoadingSplash insight={splashIns} onDone={() => {
        try { window.sessionStorage.setItem(SPLASH_KEY, "1"); } catch { /* storage unavailable */ }
        setSplash(false);
      }} />}
      
      {/* HEADER */}
      <header className="sticky top-0 z-[1000] border-b border-border bg-background/80 backdrop-blur-xl px-4 lg:px-6 py-3 flex items-center justify-between shadow-sm">
        <div className="flex items-center gap-3">
          <div className={`w-2.5 h-2.5 rounded-full ${sourceCount === 4 ? "bg-primary animate-pulse-glow" : "bg-yellow-500"}`} />
          <span className="font-display text-lg font-black tracking-widest text-primary drop-shadow-[0_0_8px_rgba(0,255,135,0.4)]">
            LIQ·INTEL
          </span>
          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${sourceCount === 4 ? "bg-primary/10 text-primary border border-primary/20" : "bg-yellow-500/10 text-yellow-500 border border-yellow-500/20"}`}>
            {data ? `${sourceCount}/4 SOURCES` : "AWAITING FEEDS"}
          </span>
        </div>
        {data && (
          <span className="text-xs text-muted-foreground font-medium hidden sm:inline-block">
            {new Date(data.timestamp).toLocaleTimeString()}
          </span>
        )}
      </header>

      {/* NAV */}
      <nav className="flex border-b border-border bg-card/50" role="tablist" aria-label="Dashboard sections">
        {TABS.map(t => {
          const Icon = t.icon;
          const isActive = tab === t.id;
          return (
            <button
              key={t.id}
              id={`${t.id}-tab`}
              role="tab"
              aria-selected={isActive}
              aria-controls={`${t.id}-panel`}
              onClick={() => { trackTelemetry("tab_change"); setTab(t.id); }}
              aria-label={t.label}
              title={t.label}
              className={`flex-1 flex items-center justify-center gap-2 py-4 text-xs font-semibold tracking-wider transition-all duration-200 border-b-2 ${
                isActive 
                  ? "border-primary text-primary bg-primary/5" 
                  : "border-transparent text-muted-foreground hover:text-foreground hover:bg-card"
              }`}
            >
              <Icon className="w-4 h-4" />
              <span className="hidden lg:inline-block">{t.label}</span>
            </button>
          );
        })}
      </nav>

      {/* MAIN CONTENT */}
      <main id={`${tab}-panel`} role="tabpanel" aria-labelledby={`${tab}-tab`} className="flex-1 p-4 lg:p-8 max-w-[1600px] w-full mx-auto">
        {tab === "alerts" ? (
          // Alert setup and SMS diagnostics stay available while live market data is down.
          <div className="space-y-8">
            <AnalysisAlerts
              symbol={selectedAsset}
              metric="price"
              range={range}
              currentValue={assets[selectedAsset]?.price}
            />
            <AlertsPanel insights={insights} />
          </div>
        ) : tab === "health" || tab === "signals" || tab === "risk" ? (
          <Suspense fallback={<div className="py-24 text-center text-xs uppercase tracking-widest text-muted-foreground">Loading…</div>}>
            {tab === "health" && <DataHealth />}
            {tab === "signals" && <MarketStructure onSelectAsset={(symbol) => { setSelectedAsset(symbol); setTab("detail"); }} />}
            {tab === "risk" && <RiskLab />}
          </Suspense>
        ) : isLoading ? (
          <div className="flex flex-col items-center justify-center py-32 opacity-50 animate-pulse">
            <Activity className="w-12 h-12 text-primary mb-4" />
            <div className="text-sm text-muted-foreground tracking-widest uppercase">Fetching Telemetry...</div>
          </div>
        ) : error && !data ? (
          <div className="flex flex-col items-center justify-center py-32">
            <AlertTriangle className="w-16 h-16 text-destructive mb-4" />
            <div className="text-destructive font-bold text-lg mb-2">Live market data is not available yet</div>
            <div className="text-sm text-muted-foreground text-center max-w-md">
              The first market sweep has not completed, or every provider is failing. The Health tab shows which source is affected and why.
            </div>
            <button type="button" onClick={() => setTab("health")} className="mt-4 rounded-lg border border-primary/40 px-4 py-2 text-xs font-semibold text-primary hover:bg-primary/10">Open Health</button>
          </div>
        ) : data ? (
          <>
            {tab === "intelligence" && <IntelligencePanel symbol={selectedAsset} range={range} />}

            {/* OVERVIEW TAB */}
            {tab === "overview" && (
              <BriefingOverview
                data={data}
                briefing={briefing.data}
                isLoading={briefing.isLoading}
                isError={briefing.isError}
                onOpenDetail={(symbol) => { setSelectedAsset(symbol); setTab("detail"); }}
                onOpenIntelligence={() => setTab("intelligence")}
                onOpenCompare={() => setTab("compare")}
              />
            )}

            {/* COMPARE TAB */}
            {tab === "compare" && (
              <CompareWorkspace
                assets={compareData}
                selected={comparison}
                onSelectedChange={symbols => { trackTelemetry("compare_change"); setComparison(symbols); }}
                range={range}
                onRangeChange={nextRange => { trackTelemetry("range_change"); setRange(nextRange); }}
                onInspect={symbol => { setSelectedAsset(symbol); setTab("detail"); }}
              />
            )}

            {/* DETAIL TAB */}
            {tab === "detail" && (
              <div className="animate-fade-up">
                {/* Asset Selector */}
                <div className="flex flex-wrap gap-2 mb-8">
                  {syms.filter(s => SYMS[s]).map(s => {
                    const isSelected = selectedAsset === s;
                    const color = SYMS[s]?.color || "#c0c4cf";
                    return (
                      <button
                        key={s}
                        onClick={() => setSelectedAsset(s)}
                        className="px-4 py-2 rounded-lg text-xs font-bold transition-all duration-200 border border-transparent hover:bg-muted"
                        style={{
                          backgroundColor: isSelected ? `${color}15` : 'transparent',
                          borderColor: isSelected ? `${color}50` : 'var(--border)',
                          color: isSelected ? color : 'var(--muted-foreground)'
                        }}
                      >
                        {s}
                      </button>
                    );
                  })}
                </div>

                {assets[selectedAsset] ? (
                  <div className="space-y-6">
                    <LongPressTile target={{ title: `${selectedAsset} price`, symbol: selectedAsset, metric: "price", currentValue: assets[selectedAsset].price, format: "price", accent: SYMS[selectedAsset]?.color }}>
                      <div className="flex items-baseline gap-4 mb-4">
                        <h2
                          className="font-display text-4xl lg:text-6xl font-black drop-shadow-xl"
                          style={{ color: SYMS[selectedAsset]?.color || 'var(--foreground)' }}
                        >
                          ${fmtPrice(assets[selectedAsset].price)}
                        </h2>
                        <span className={`text-lg lg:text-xl font-bold flex items-center gap-1 ${assets[selectedAsset].change24h! >= 0 ? "text-primary" : "text-destructive"}`}>
                          {assets[selectedAsset].change24h! >= 0 ? <TrendingUp className="w-5 h-5" /> : <TrendingDown className="w-5 h-5" />}
                          {Math.abs(assets[selectedAsset].change24h || 0).toFixed(2)}%
                        </span>
                        <span className="text-sm text-muted-foreground">24h</span>
                      </div>
                    </LongPressTile>

                    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                      {[
                        { l: "Market Cap", v: `$${fmt(assets[selectedAsset].mcap)}`, metric: "marketCap" as const, currentValue: assets[selectedAsset].mcap, format: "compact" as const },
                        { l: "24h Volume", v: `$${fmt(assets[selectedAsset].vol24h)}`, metric: "volume" as const, currentValue: assets[selectedAsset].vol24h, format: "compact" as const },
                        { l: "24h High", v: `$${fmtPrice(assets[selectedAsset].high24h)}`, metric: "price" as const, currentValue: assets[selectedAsset].high24h, format: "price" as const, displayMetricName: "24-hour high", unavailableReason: "The rolling 24-hour high is supplied as a current snapshot only. Current-price history is not presented as a high series." },
                        { l: "24h Low", v: `$${fmtPrice(assets[selectedAsset].low24h)}`, metric: "price" as const, currentValue: assets[selectedAsset].low24h, format: "price" as const, displayMetricName: "24-hour low", unavailableReason: "The rolling 24-hour low is supplied as a current snapshot only. Current-price history is not presented as a low series." },
                        { l: "All Time High", v: `$${fmtPrice(assets[selectedAsset].ath)}`, metric: "price" as const, currentValue: assets[selectedAsset].ath, format: "price" as const, displayMetricName: "all-time high", unavailableReason: "The all-time-high record is a point-in-time reference. It does not have a dedicated stored series." },
                        { l: "ATH Date", v: assets[selectedAsset].athDate ? new Date(assets[selectedAsset].athDate!).toLocaleDateString() : '—', metric: "price" as const, currentValue: null, format: "number" as const, displayMetricName: "all-time-high date", unavailableReason: "The all-time-high date is a reference field, not a numeric time series." },
                        { l: "1h Change", v: `${assets[selectedAsset].change1h! > 0 ? '+' : ''}${(assets[selectedAsset].change1h || 0).toFixed(2)}%`, metric: "price" as const, currentValue: assets[selectedAsset].change1h, c: assets[selectedAsset].change1h! >= 0 ? 'text-primary' : 'text-destructive', format: "percent" as const, displayMetricName: "1-hour return", unavailableReason: "This provider return is a current snapshot. Price history is not relabeled as a return series." },
                        { l: "7d Change", v: `${assets[selectedAsset].change7d! > 0 ? '+' : ''}${(assets[selectedAsset].change7d || 0).toFixed(2)}%`, metric: "price" as const, currentValue: assets[selectedAsset].change7d, c: assets[selectedAsset].change7d! >= 0 ? 'text-primary' : 'text-destructive', format: "percent" as const, displayMetricName: "7-day return", unavailableReason: "This provider return is a current snapshot. Price history is not relabeled as a return series." },
                        { l: "30d Change", v: `${assets[selectedAsset].change30d! > 0 ? '+' : ''}${(assets[selectedAsset].change30d || 0).toFixed(2)}%`, metric: "price" as const, currentValue: assets[selectedAsset].change30d, c: assets[selectedAsset].change30d! >= 0 ? 'text-primary' : 'text-destructive', format: "percent" as const, displayMetricName: "30-day return", unavailableReason: "This provider return is a current snapshot. Price history is not relabeled as a return series." },
                        { l: "TVL", v: assets[selectedAsset].tvl! > 0 ? `$${fmt(assets[selectedAsset].tvl)}` : '—', metric: "tvl" as const, currentValue: assets[selectedAsset].tvl, format: "compact" as const },
                        { l: "DEX Volume", v: assets[selectedAsset].dexVol! > 0 ? `$${fmt(assets[selectedAsset].dexVol)}` : '—', metric: "dexVolume" as const, currentValue: assets[selectedAsset].dexVol, format: "compact" as const },
                        { l: "Market Rank", v: `#${assets[selectedAsset].rank || '—'}`, metric: "marketCap" as const, currentValue: null, format: "number" as const, displayMetricName: "market rank", unavailableReason: "Market rank is currently supplied as a snapshot reference. A rank history is not stored." },
                      ].map((k, i) => (
                        <LongPressTile key={i} target={{ title: `${selectedAsset} ${k.l}`, symbol: selectedAsset, metric: k.metric, currentValue: k.currentValue, format: k.format, accent: SYMS[selectedAsset]?.color, displayMetricName: k.displayMetricName, unavailableReason: k.unavailableReason }}>
                          <div className="h-full bg-card border border-border rounded-xl p-4 hover:bg-muted/50 transition-colors">
                            <div className="text-[10px] text-muted-foreground uppercase tracking-widest font-semibold mb-2">{k.l}</div>
                            <div className={`text-base font-bold ${k.c || ""}`} style={!k.c ? { color: SYMS[selectedAsset]?.color || 'var(--foreground)' } : {}}>
                              {k.v}
                            </div>
                          </div>
                        </LongPressTile>
                      ))}
                    </div>

                    <LongPressTile target={{ title: `${selectedAsset} performance changes`, symbol: selectedAsset, metric: "price", currentValue: null, format: "percent", accent: SYMS[selectedAsset]?.color, displayMetricName: "reported performance changes", unavailableReason: "This panel compares current provider-return snapshots across windows. It is not a stored price timeline." }}>
                      <div className="bg-card border border-border rounded-xl p-6">
                        <div className="text-xs text-muted-foreground uppercase tracking-widest font-semibold mb-6">Performance Across Timeframes</div>
                        <DynamicBarChart
                          data={[
                            { name: "1h", v: assets[selectedAsset].change1h || 0 },
                            { name: "24h", v: assets[selectedAsset].change24h || 0 },
                            { name: "7d", v: assets[selectedAsset].change7d || 0 },
                            { name: "30d", v: assets[selectedAsset].change30d || 0 }
                          ]}
                          dataKey="v"
                          height={250}
                          formatter={(v) => `${v.toFixed(1)}%`}
                          colorFn={(d) => d.v >= 0 ? "#00ff8788" : "#ff3b3b88"}
                          showReference={true}
                        />
                      </div>
                    </LongPressTile>
                  </div>
                ) : (
                  <div className="py-20 text-center text-muted-foreground">Select an asset to view details.</div>
                )}
              </div>
            )}
          </>
        ) : null}
      </main>
      
      {/* Footer */}
      <footer className="mt-auto border-t border-border bg-card/30 p-4 text-xs text-muted-foreground flex flex-col sm:flex-row justify-between items-center gap-2">
        <div className="font-semibold tracking-wider">LIQ·INTEL MARKET WORKSPACE</div>
        <div className="flex gap-4">
          <span>{syms.length} Assets Analyzed</span>
          <span className="hidden sm:inline-block">&bull;</span>
          <span>Data: CoinGecko, DefiLlama, Coinbase, Kraken, alternative.me · Not investment advice</span>
        </div>
      </footer>
    </div>
  );
}
