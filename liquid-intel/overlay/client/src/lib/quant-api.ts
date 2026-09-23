import { useQuery } from "@tanstack/react-query";
import type { MarketStructure } from "@shared/quant/structure";
import type { RiskLabModel } from "@shared/quant/api-types";
import type { SmsDiagnostics } from "@shared/alerts";
// Type-only: erased at build time, so no server code reaches the browser bundle.
import type { PipelineHealth } from "../../../server/pipeline-health";

export type { PipelineHealth };
export type DailyHistoryStatus = PipelineHealth["dailyHistory"];

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly body: unknown) {
    super(message);
    this.name = "ApiError";
  }
}

export async function getJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: "include", ...init });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = body && typeof body === "object" && typeof (body as { message?: unknown }).message === "string"
      ? (body as { message: string }).message
      : `Request failed (${response.status})`;
    throw new ApiError(message, response.status, body);
  }
  return body as T;
}

/** History that is still loading answers 503 with its status; poll faster until it is ready. */
function loadingAwareInterval(ready: number, loading: number) {
  return (query: { state: { error: unknown } }) => (query.state.error instanceof ApiError && query.state.error.status === 503 ? loading : ready);
}

export function historyFromError(error: unknown): DailyHistoryStatus | null {
  if (!(error instanceof ApiError) || !error.body || typeof error.body !== "object") return null;
  return ((error.body as { history?: DailyHistoryStatus }).history) ?? null;
}

export function useMarketStructure() {
  return useQuery({
    queryKey: ["/api/market-structure"],
    queryFn: () => getJson<{ structure: MarketStructure; history: DailyHistoryStatus }>("/api/market-structure"),
    staleTime: 60_000,
    refetchInterval: loadingAwareInterval(5 * 60_000, 20_000),
    retry: false,
  });
}

export function useRiskLabModel(lookbackDays: number) {
  return useQuery({
    queryKey: ["/api/risk-lab/model", lookbackDays],
    queryFn: () => getJson<RiskLabModel>(`/api/risk-lab/model?lookback=${lookbackDays}`),
    staleTime: 5 * 60_000,
    refetchInterval: loadingAwareInterval(30 * 60_000, 20_000),
    retry: false,
  });
}

export function usePipelineHealth() {
  return useQuery({
    queryKey: ["/api/health/pipeline"],
    queryFn: () => getJson<PipelineHealth>("/api/health/pipeline"),
    staleTime: 5_000,
    refetchInterval: 15_000,
    retry: 1,
  });
}

export function fetchSmsDiagnostics(): Promise<SmsDiagnostics> {
  return getJson<SmsDiagnostics>("/api/alerts/diagnostics");
}

export function sendTestPush(message?: string): Promise<{ message: string }> {
  return getJson<{ message: string }>("/api/alerts/test-push", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(message ? { message } : {}),
  });
}

export const pct = (value: number | null | undefined, digits = 1, signed = true): string => {
  if (value == null || !Number.isFinite(value)) return "—";
  const text = `${(value * 100).toFixed(digits)}%`;
  return signed && value > 0 ? `+${text}` : text;
};

export const usd = (value: number | null | undefined): string => {
  if (value == null || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1e12) return `${sign}$${(abs / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e4) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${abs.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
};

export const ago = (iso: string | null | undefined): string => {
  if (!iso) return "never";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "unknown";
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
};
