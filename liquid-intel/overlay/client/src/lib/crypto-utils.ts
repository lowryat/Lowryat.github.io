import { DashboardData } from "@shared/schema";
import { Activity, Landmark, TrendingDown, TrendingUp, Zap, Swords, Coins } from "lucide-react";

export const SYMS: Record<string, { cat: string; color: string }> = {
  BTC: { cat: "Settlement", color: "#F7931A" },
  ETH: { cat: "Settlement", color: "#627EEA" },
  SOL: { cat: "High Liq L1", color: "#9945FF" },
  AVAX: { cat: "High Liq L1", color: "#E84142" },
  BNB: { cat: "High Liq L1", color: "#F0B90B" },
  NEAR: { cat: "High Liq L1", color: "#00C08B" },
  ATOM: { cat: "Modular", color: "#6F7390" },
  TIA: { cat: "Modular", color: "#7B2FBE" },
  DOT: { cat: "Modular", color: "#E6007A" },
  APT: { cat: "Parallel", color: "#06BCC1" },
  SUI: { cat: "Parallel", color: "#4DA2FF" },
  SEI: { cat: "Parallel", color: "#9B1C1C" },
  XRP: { cat: "Payments", color: "#5A6A7A" },
  LTC: { cat: "Payments", color: "#345D9D" },
  ARB: { cat: "L2", color: "#28A0F0" },
  OP: { cat: "L2", color: "#FF0420" },
  INJ: { cat: "High Liq L1", color: "#00F2FE" },
  TON: { cat: "High Liq L1", color: "#0098EA" },
  LINK: { cat: "Modular", color: "#2A5ADA" },
  UNI: { cat: "L2", color: "#FF007A" },
  AAVE: { cat: "Modular", color: "#B6509E" },
  FTM: { cat: "High Liq L1", color: "#1969FF" }
};

export function fmt(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return "—";
  if (Math.abs(n) >= 1e12) return (n / 1e12).toFixed(1) + "T";
  if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return n.toFixed(n < 10 ? 2 : 0);
}

export function fmtPrice(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (n >= 1) return n.toFixed(2);
  return n.toFixed(4);
}

export type InsightType = "bull" | "bear" | "alert" | "info";

export interface Insight {
  tp: InsightType;
  ic: any; // React component
  hl: string;
  dt: string;
  pr: number;
}

export function liveInsights(data?: DashboardData | null): Insight[] {
  if (!data || !data.assets) return [{ tp: "info", ic: Activity, hl: "Loading market data...", dt: "", pr: 1 }];
  
  const ins: Insight[] = [];
  const a = data.assets;
  
  // BTC 24h
  if (a.BTC) {
    const bc = a.BTC.change24h || 0;
    if (Math.abs(bc) > 3) {
      ins.push({
        tp: bc > 0 ? "bull" : "bear",
        ic: bc > 0 ? TrendingUp : TrendingDown,
        hl: `BTC ${bc > 0 ? "up" : "down"} ${Math.abs(bc).toFixed(1)}% in 24h — $${fmtPrice(a.BTC.price)}`,
        dt: "A one-day move. The Signals tab shows whether trend and momentum agree over 30 to 200 days, and the Risk Lab shows what a move like this does to a portfolio.",
        pr: 1
      });
    }
  }

  // Stablecoin mcap
  if (data.stablecoinMcap != null && data.stablecoinMcap > 0) {
    ins.push({
      tp: "info",
      ic: Coins,
      hl: `Stablecoin market cap: $${fmt(data.stablecoinMcap)}`,
      dt: "A level on its own says little. The Signals tab compares the 30-day change with its one-year norm and reports how BTC performed after similar changes.",
      pr: 2
    });
  }

  // Best performer 24h
  let best: { s: string, v: number } | undefined;
  let worst: { s: string, v: number } | undefined;

  for (const s of Object.keys(a)) {
    const c = a[s].change24h || 0;
    if (!best || c > best.v) best = { s, v: c };
    if (!worst || c < worst.v) worst = { s, v: c };
  }

  if (best && best.v > 5) {
    ins.push({
      tp: "bull",
      ic: Zap,
      hl: `${best.s} surging +${best.v.toFixed(1)}% (24h) — leading the market`,
      dt: "Strongest 24h performer among tracked assets. Check whether volume and the longer trend confirm it.",
      pr: 2
    });
  }

  if (worst && worst.v < -5) {
    ins.push({
      tp: "bear",
      ic: TrendingDown,
      hl: `${worst.s} down ${Math.abs(worst.v).toFixed(1)}% (24h) — weakest performer`,
      dt: "Sharpest 24h decline among tracked assets. Check whether volume and the broader market confirm it before drawing conclusions.",
      pr: 3
    });
  }

  // TVL
  if (data.totalTvl != null && data.totalTvl > 0) {
    ins.push({
      tp: "info",
      ic: Landmark,
      hl: `Total DeFi TVL: $${fmt(data.totalTvl)}`,
      dt: "Total value locked across all chains. TVL moves with token prices, so compare its change with the market before reading it as new capital.",
      pr: 4
    });
  }

  // ETH vs SOL volume
  if (a.ETH && a.SOL && a.ETH.vol24h && a.SOL.vol24h) {
    const ratio = a.SOL.vol24h / a.ETH.vol24h;
    if (ratio > 0.3) {
      ins.push({
        tp: "info",
        ic: Swords,
        hl: `SOL 24h trading volume is ${Math.round(ratio * 100)}% of ETH's`,
        dt: "Relative trading activity for one day. A single day of volume is not evidence of a structural shift.",
        pr: 3
      });
    }
  }

  if (!ins.length) {
    ins.push({
      tp: "info",
      ic: Activity,
      hl: "No large 24h moves among tracked assets.",
      dt: "Open Signals for trend, breadth, and liquidity context.",
      pr: 1
    });
  }

  return ins.sort((a, b) => a.pr - b.pr);
}
