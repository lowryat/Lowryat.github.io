/** Response contract for GET /api/risk-lab/model, shared by server and client. */
export type RiskLabModel = {
  asOf: string;
  lookbackDays: number;
  symbols: string[];
  /** Date of each return (the close it ends on). */
  dates: string[];
  /** Aligned daily log returns, one array per symbol, oldest first. */
  returns: number[][];
  prices: number[];
  excluded: Array<{ symbol: string; reason: string }>;
  defaultWeights: number[];
  regime: "bull" | "bear" | "transition" | "unknown";
  stablecoinElasticity: { slope: number; r2: number; tStat: number; n: number } | null;
  sources: Record<string, string | null>;
};
