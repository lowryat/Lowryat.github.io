import { useEffect, useId, useState } from "react";
import { BellRing, Eye, Loader2, Pencil, Plus, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { trackTelemetry } from "@/lib/telemetry";
import type {
  AnalysisAlertDeliveryStatus,
  AnalysisAlertCondition,
  AnalysisAlertMetric,
  AnalysisAlertRule,
  AnalysisAlertSource,
  AnalysisAlertsStatus,
} from "@shared/analysis-alerts";
import type { HistoryMetric, HistoryRange } from "@shared/history";
import type { AlertRecipient, AlertStatus } from "@shared/alerts";

const historyMetricOptions: Array<{ value: HistoryMetric; label: string }> = [
  { value: "price", label: "Price" },
  { value: "marketCap", label: "Market cap" },
  { value: "stablecoinMcap", label: "Stablecoin market cap" },
  { value: "tvl", label: "TVL" },
  { value: "volume", label: "24h volume" },
  { value: "dexVolume", label: "DEX volume" },
  { value: "snapshotVwap", label: "Snapshot VWAP" },
  { value: "flowMomentum", label: "Flow momentum" },
];
const coinGlassMetricOptions: Array<{ value: AnalysisAlertMetric; label: string }> = [
  { value: "fundingRate", label: "Funding rate" },
  { value: "openInterestUsd", label: "Open interest (USD)" },
  { value: "longLiquidationsUsd", label: "Long liquidations (USD)" },
  { value: "shortLiquidationsUsd", label: "Short liquidations (USD)" },
  { value: "longShortAccountRatio", label: "Long/short account ratio" },
  { value: "fundingZScore", label: "Funding-rate z-score" },
  { value: "liquidationZScore", label: "Liquidation z-score" },
  { value: "priceOiDivergence", label: "Price / OI divergence (percentage points)" },
];
const intelligenceMetricOptions: Array<{ value: AnalysisAlertMetric; label: string }> = [
  { value: "breadth", label: "Market breadth" },
  { value: "relativeStrength", label: "Relative strength" },
  { value: "correlation", label: "BTC correlation" },
  { value: "dispersion", label: "Cross-asset dispersion" },
  { value: "volatility", label: "Realized volatility" },
  { value: "drawdown", label: "Range drawdown" },
  { value: "liquidityAdjustedReturn", label: "Liquidity-adjusted return" },
  { value: "liquidityImpulse", label: "Liquidity impulse" },
  { value: "liquidityDivergence", label: "Liquidity divergence" },
  { value: "chainRotation", label: "Chain rotation" },
  { value: "anomaly", label: "Return anomaly" },
  { value: "regime", label: "Market regime" },
];
const ranges: HistoryRange[] = ["1h", "6h", "24h", "7d"];
const conditions: Array<{ value: AnalysisAlertCondition; label: string }> = [
  { value: "above", label: "Above" },
  { value: "below", label: "Below" },
  { value: "crossAbove", label: "Crosses above" },
  { value: "crossBelow", label: "Crosses below" },
];

export type AnalysisAlertComposerProps = {
  symbol: string;
  metric: AnalysisAlertMetric;
  range: HistoryRange;
  currentValue?: number | null;
  source?: AnalysisAlertSource;
  /** Called after the server creates or edits the durable rule. */
  onCreated?: (rule: AnalysisAlertRule) => void;
  editingRule?: AnalysisAlertRule | null;
  onCancelEdit?: () => void;
};

type FormState = {
  source: AnalysisAlertSource;
  symbol: string;
  metric: AnalysisAlertMetric;
  window: HistoryRange;
  condition: AnalysisAlertCondition;
  threshold: string;
  cooldownSeconds: string;
  enabled: boolean;
  deliveryChannel: "in_app" | "sms";
  deliveryRecipientId: string;
};

function stateFrom(props: AnalysisAlertComposerProps): FormState {
  const rule = props.editingRule;
  const selectedSource = rule?.source ?? props.source ?? "history";
  return {
    source: selectedSource,
    symbol: rule?.symbol ?? props.symbol.toUpperCase(),
    metric: rule?.metric ?? props.metric,
    window: rule?.window ?? props.range,
    condition: rule?.condition ?? "above",
    threshold: String(rule?.threshold ?? props.currentValue ?? ""),
    cooldownSeconds: String(rule?.cooldownSeconds ?? 300),
    enabled: rule?.enabled ?? true,
    deliveryChannel: rule?.deliveryChannel ?? "in_app",
    deliveryRecipientId: rule?.deliveryRecipientId ?? "",
  };
}

async function apiRequest(path: string, options: RequestInit = {}) {
  const response = await fetch(path, {
    ...options,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || "Analysis alert request failed.");
  return body;
}

export async function loadAnalysisAlertRecipients(fetcher: typeof fetch = fetch): Promise<AlertRecipient[]> {
  const response = await fetcher("/api/alerts", { credentials: "include" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((body as { message?: string }).message || "Could not load SMS recipients.");
  return (body as AlertStatus).recipients.filter((recipient) => recipient.enabled);
}

export function AnalysisAlertComposer(props: AnalysisAlertComposerProps) {
  const ids = useId().replace(/:/g, "");
  const [form, setForm] = useState<FormState>(() => stateFrom(props));
  const [message, setMessage] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState<"preview" | "save" | null>(null);
  const [recipients, setRecipients] = useState<AlertRecipient[]>([]);
  const [recipientLoadState, setRecipientLoadState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    setForm(stateFrom(props));
    setMessage(null);
    setPreview(null);
  }, [props.editingRule?.id, props.symbol, props.metric, props.range, props.currentValue, props.source]);

  useEffect(() => {
    let active = true;
    setRecipientLoadState("loading");
    loadAnalysisAlertRecipients()
      .then((loaded) => {
        if (!active) return;
        setRecipients(loaded);
        setRecipientLoadState("ready");
      })
      .catch(() => {
        if (!active) return;
        setRecipients([]);
        setRecipientLoadState("error");
      });
    return () => {
      active = false;
    };
  }, []);

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function changeSource(nextSource: AnalysisAlertSource) {
    setForm((current) => ({
      ...current,
      source: nextSource,
      metric: nextSource === "coinglass"
        ? (coinGlassMetricOptions.some((option) => option.value === current.metric) ? current.metric : "fundingRate")
        : nextSource === "intelligence"
          ? (intelligenceMetricOptions.some((option) => option.value === current.metric) ? current.metric : "breadth")
          : (historyMetricOptions.some((option) => option.value === current.metric) ? current.metric : "price"),
    }));
  }

  function payload() {
    const threshold = Number(form.threshold);
    const cooldownSeconds = Number(form.cooldownSeconds);
    if (!Number.isFinite(threshold)) throw new Error("Threshold must be a finite number.");
    if (!Number.isInteger(cooldownSeconds) || cooldownSeconds < 60) throw new Error("Cooldown must be at least 60 seconds.");
    return {
      ...form,
      threshold,
      cooldownSeconds,
      deliveryRecipientId: form.deliveryChannel === "sms" ? form.deliveryRecipientId || undefined : undefined,
    };
  }

  async function previewRule() {
    setMessage(null);
    if (props.currentValue == null || !Number.isFinite(props.currentValue)) {
      setPreview("A current value is required to preview this condition.");
      return;
    }
    setBusy("preview");
    try {
      // Ensure a signed, HttpOnly owner cookie exists before the POST.
      await fetch("/api/analysis-alerts", { credentials: "include" });
      const body = await apiRequest("/api/analysis-alerts/preview", {
        method: "POST",
        body: JSON.stringify({ ...payload(), currentValue: props.currentValue }),
      });
      setPreview(body.message as string);
    } catch (error) {
      setPreview(error instanceof Error ? error.message : "Unable to preview condition.");
    } finally {
      setBusy(null);
    }
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setMessage(null);
    setBusy("save");
    try {
      await fetch("/api/analysis-alerts", { credentials: "include" });
      const body = await apiRequest(props.editingRule ? `/api/analysis-alerts/${props.editingRule.id}` : "/api/analysis-alerts", {
        method: props.editingRule ? "PATCH" : "POST",
        body: JSON.stringify(payload()),
      });
      if (!props.editingRule) trackTelemetry("alert_create");
      props.onCreated?.(body.rule as AnalysisAlertRule);
      setMessage(props.editingRule ? "Rule updated." : "Analysis alert saved.");
      if (!props.editingRule) setForm((current) => ({ ...current, threshold: String(props.currentValue ?? "") }));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to save analysis alert.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <form onSubmit={save} className="space-y-4 rounded-xl border border-border bg-card p-5 shadow-sm">
      <div>
        <div className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          {props.editingRule ? "Edit analysis alert" : "Analysis threshold alert"}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">Choose in-app history or opt in to an SMS delivery attempt when the rule triggers.</p>
        <p role="note" className="mt-2 rounded-md border border-yellow-500/30 bg-yellow-500/[0.04] px-2 py-1.5 text-[11px] leading-relaxed text-yellow-200/90">Continuous server availability is required to evaluate alerts and collect their inputs. Autoscale sleep interrupts alert evaluation and ingestion, so this application does not promise 24/7 monitoring.</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label htmlFor={`${ids}-source`} className="grid gap-1.5 text-xs font-medium text-foreground">
          Source
          <select id={`${ids}-source`} value={form.source} onChange={(event) => changeSource(event.target.value as AnalysisAlertSource)} className="h-10 rounded-md border border-input bg-background px-3 text-sm">
            <option value="history">Stored market history</option>
            <option value="intelligence">Market intelligence</option>
            <option value="coinglass">CoinGlass</option>
          </select>
        </label>
        <label htmlFor={`${ids}-symbol`} className="grid gap-1.5 text-xs font-medium text-foreground">
          Symbol
          <Input id={`${ids}-symbol`} value={form.symbol} maxLength={30} onChange={(event) => update("symbol", event.target.value.toUpperCase())} required />
        </label>
        <label htmlFor={`${ids}-metric`} className="grid gap-1.5 text-xs font-medium text-foreground">
          Metric
          <select id={`${ids}-metric`} value={form.metric} onChange={(event) => update("metric", event.target.value as AnalysisAlertMetric)} className="h-10 rounded-md border border-input bg-background px-3 text-sm">
            {(form.source === "coinglass" ? coinGlassMetricOptions : form.source === "intelligence" ? intelligenceMetricOptions : historyMetricOptions).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <label htmlFor={`${ids}-window`} className="grid gap-1.5 text-xs font-medium text-foreground">
          Analysis window
          <select id={`${ids}-window`} value={form.window} onChange={(event) => update("window", event.target.value as HistoryRange)} className="h-10 rounded-md border border-input bg-background px-3 text-sm">
            {ranges.map((range) => <option key={range} value={range}>{range}</option>)}
          </select>
        </label>
        <label htmlFor={`${ids}-condition`} className="grid gap-1.5 text-xs font-medium text-foreground">
          Condition
          <select id={`${ids}-condition`} value={form.condition} onChange={(event) => update("condition", event.target.value as AnalysisAlertCondition)} className="h-10 rounded-md border border-input bg-background px-3 text-sm">
            {conditions.map((condition) => <option key={condition.value} value={condition.value}>{condition.label}</option>)}
          </select>
        </label>
        <label htmlFor={`${ids}-threshold`} className="grid gap-1.5 text-xs font-medium text-foreground">
          Threshold
          <Input id={`${ids}-threshold`} type="number" step="any" value={form.threshold} onChange={(event) => update("threshold", event.target.value)} required />
        </label>
        <label htmlFor={`${ids}-cooldown`} className="grid gap-1.5 text-xs font-medium text-foreground">
          Cooldown (seconds)
          <Input id={`${ids}-cooldown`} type="number" min={60} max={604800} step={1} value={form.cooldownSeconds} onChange={(event) => update("cooldownSeconds", event.target.value)} required />
        </label>
        <div className="flex items-end">
          <label className="flex h-10 items-center gap-3 text-xs font-medium text-foreground">
            <Switch checked={form.enabled} onCheckedChange={(value) => update("enabled", value)} aria-label="Enable analysis alert" />
            Enable rule
          </label>
        </div>
        <label htmlFor={`${ids}-delivery-channel`} className="grid gap-1.5 text-xs font-medium text-foreground">
          Delivery channel
          <select id={`${ids}-delivery-channel`} value={form.deliveryChannel} onChange={(event) => update("deliveryChannel", event.target.value as FormState["deliveryChannel"])} className="h-10 rounded-md border border-input bg-background px-3 text-sm">
            <option value="in_app">In-app history only</option>
            <option value="sms">SMS text message</option>
          </select>
        </label>
        {form.deliveryChannel === "sms" && (
          <label htmlFor={`${ids}-delivery-recipient`} className="grid gap-1.5 text-xs font-medium text-foreground">
            SMS recipient
            <select
              id={`${ids}-delivery-recipient`}
              value={form.deliveryRecipientId}
              onChange={(event) => update("deliveryRecipientId", event.target.value)}
              className="h-10 rounded-md border border-input bg-background px-3 text-sm"
              disabled={recipientLoadState !== "ready"}
              required
            >
              <option value="">
                {recipientLoadState === "loading"
                  ? "Loading recipients…"
                  : recipientLoadState === "error"
                    ? "Recipients unavailable"
                    : recipients.length
                      ? "Select an enabled recipient"
                      : "No enabled recipients available"}
              </option>
              {props.editingRule?.deliveryRecipientId
                && !recipients.some((recipient) => recipient.id === props.editingRule?.deliveryRecipientId)
                && (
                  <option value={props.editingRule.deliveryRecipientId} disabled>
                    Current recipient is {props.editingRule.deliveryDestinationState}
                  </option>
                )}
              {recipients.map((recipient) => (
                <option key={recipient.id} value={recipient.id}>{recipient.name} · {recipient.displayPhone}</option>
              ))}
            </select>
            <span className="text-[11px] font-normal text-muted-foreground">
              {recipientLoadState === "error"
                ? "Could not load recipients. Refresh the page and try again."
                : "Manage phone numbers in Alerts. Recipient changes apply to future deliveries."}
            </span>
          </label>
        )}
      </div>
      {preview && <p role="status" className="rounded-md border border-border bg-background/50 px-3 py-2 text-xs text-muted-foreground">{preview}</p>}
      {message && <p role="status" className="text-xs text-muted-foreground">{message}</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" onClick={previewRule} disabled={busy !== null}>
          {busy === "preview" ? <Loader2 className="animate-spin" /> : <Eye />}
          Preview condition
        </Button>
        <Button type="submit" disabled={busy !== null}>
          {busy === "save" ? <Loader2 className="animate-spin" /> : <Plus />}
          {props.editingRule ? "Save changes" : "Create alert"}
        </Button>
        {props.editingRule && <Button type="button" variant="ghost" onClick={props.onCancelEdit}>Cancel edit</Button>}
      </div>
    </form>
  );
}

export type AnalysisAlertsProps = {
  symbol?: string;
  metric?: AnalysisAlertMetric;
  range?: HistoryRange;
  currentValue?: number | null;
  source?: AnalysisAlertSource;
};

export function AnalysisAlerts({
  symbol = "BTC",
  metric = "price",
  range = "24h",
  currentValue,
  source = "history",
}: AnalysisAlertsProps) {
  const [status, setStatus] = useState<AnalysisAlertsStatus | null>(null);
  const [editing, setEditing] = useState<AnalysisAlertRule | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [retryingEventId, setRetryingEventId] = useState<string | null>(null);

  async function refresh() {
    const response = await fetch("/api/analysis-alerts", { credentials: "include" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.message || "Could not load analysis alerts.");
    setStatus(body as AnalysisAlertsStatus);
  }

  useEffect(() => {
    let active = true;
    const refreshIfActive = () => refresh().catch((error) => {
      if (active) setNotice(error instanceof Error ? error.message : "Could not load analysis alerts.");
    });
    void refreshIfActive();
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void refreshIfActive();
    }, 30_000);
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") void refreshIfActive();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      active = false;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  async function patchRule(id: string, changes: Partial<AnalysisAlertRule>) {
    try {
      const body = await apiRequest(`/api/analysis-alerts/${id}`, { method: "PATCH", body: JSON.stringify(changes) });
      setStatus((current) => current && { ...current, rules: current.rules.map((rule) => rule.id === id ? body.rule : rule) });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not update rule.");
    }
  }

  async function deleteRule(id: string) {
    try {
      await apiRequest(`/api/analysis-alerts/${id}`, { method: "DELETE" });
      setStatus((current) => current && { ...current, rules: current.rules.filter((rule) => rule.id !== id) });
      setEditing((current) => current?.id === id ? null : current);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not delete rule.");
    }
  }

  async function retryDelivery(eventId: string) {
    setRetryingEventId(eventId);
    setNotice(null);
    try {
      trackTelemetry("retry");
      const body = await apiRequest(`/api/analysis-alerts/events/${eventId}/retry`, { method: "POST" });
      await refresh();
      setNotice(
        body.deliveryStatus === "sent"
          ? "SMS retry accepted by Twilio. The log updates when the carrier confirms delivery."
          : body.deliveryStatus === "rate_limited"
            ? "SMS retry was rate limited by the rule cooldown."
            : "SMS retry failed; the new attempt is recorded in history.",
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not retry SMS delivery.");
    } finally {
      setRetryingEventId(null);
    }
  }

  function deliveryStatusLabel(status: AnalysisAlertDeliveryStatus): string {
    // "sent" only means Twilio accepted the message; the carrier receipt decides delivery.
    const labels: Partial<Record<AnalysisAlertDeliveryStatus, string>> = {
      rate_limited: "rate limited",
      sent: "accepted by Twilio, awaiting carrier receipt",
      delivered: "delivered to phone",
      undelivered: "not delivered by carrier",
    };
    return labels[status] ?? status;
  }

  return (
    <section className="space-y-5">
      <div className="flex items-center gap-2">
        <BellRing className="h-5 w-5 text-primary" />
        <div>
          <h2 className="font-display text-xl font-bold text-foreground">Analysis alerts</h2>
          <p className="text-xs text-muted-foreground">Durable, private rules with an in-app trigger log.</p>
        </div>
      </div>
      {notice && <p role="status" className="rounded-md border border-border px-3 py-2 text-xs text-muted-foreground">{notice}</p>}
      <AnalysisAlertComposer
        symbol={symbol}
        metric={metric}
        range={range}
        currentValue={currentValue}
        source={source}
        editingRule={editing}
        onCancelEdit={() => setEditing(null)}
        onCreated={(saved) => {
          setStatus((current) => {
            if (!current) return { rules: [saved], events: [] };
            const exists = current.rules.some((rule) => rule.id === saved.id);
            return { ...current, rules: exists ? current.rules.map((rule) => rule.id === saved.id ? saved : rule) : [saved, ...current.rules] };
          });
          setEditing(null);
        }}
      />
      <div className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Your rules</h3>
        {status?.rules.length ? status.rules.map((rule) => (
          <div key={rule.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card p-3">
            <Switch checked={rule.enabled} onCheckedChange={(enabled) => patchRule(rule.id, { enabled })} aria-label={`Enable ${rule.symbol} ${rule.metric} alert`} />
            <div className="min-w-0 flex-1">
              <p className="font-mono text-xs font-semibold text-foreground">{rule.symbol} · {rule.metric} {rule.condition} {rule.threshold}</p>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {rule.source} · {rule.window} · {rule.cooldownSeconds}s cooldown · {rule.deliveryChannel === "sms"
                    ? `SMS ${rule.deliveryPhoneDisplay || ""} (${rule.deliveryDestinationState.replace("_", " ")})`
                    : "in-app"} · {rule.lastResult || "not evaluated"}
                </p>
                {rule.lastResultDetail && (
                  <p className="mt-1 text-[11px] text-muted-foreground/80">{rule.lastResultDetail}</p>
                )}
            </div>
            <Button type="button" size="icon" variant="ghost" onClick={() => setEditing(rule)} aria-label={`Edit ${rule.symbol} alert`}><Pencil className="h-4 w-4" /></Button>
            <Button type="button" size="icon" variant="ghost" onClick={() => deleteRule(rule.id)} aria-label={`Delete ${rule.symbol} alert`}><Trash2 className="h-4 w-4 text-destructive" /></Button>
          </div>
        )) : <p className="rounded-lg border border-dashed border-border p-4 text-center text-xs text-muted-foreground">No analysis alerts yet.</p>}
      </div>
      <div className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Trigger log</h3>
        {status?.events.length ? status.events.slice(0, 10).map((event) => (
          <div key={event.id} className="rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-semibold text-foreground">{event.symbol} {event.condition} {event.threshold}</span>
                <span>{" · "}value {event.value} · {event.channel === "sms" ? "SMS" : "in-app"} {deliveryStatusLabel(event.deliveryStatus)}</span>
                <span>· {new Date(event.createdAt).toLocaleString()}</span>
                {event.retryable && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => retryDelivery(event.id)}
                    disabled={retryingEventId !== null}
                    aria-label={`Retry SMS delivery for ${event.symbol} alert`}
                  >
                    {retryingEventId === event.id ? <Loader2 className="animate-spin" /> : <RotateCcw />}
                    Retry SMS
                  </Button>
                )}
              </div>
              {event.channel === "sms" && event.deliveryAttempts.length > 0 && (
                <div className="mt-2 space-y-1.5 border-l border-border/70 pl-3" aria-label={`SMS delivery attempts for ${event.symbol} alert`}>
                  {event.deliveryAttempts.map((delivery) => (
                    <div key={delivery.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[11px]">
                      <span className="font-medium text-foreground">
                        {delivery.attemptNumber === 1 ? "Original delivery" : `Retry ${delivery.attemptNumber - 1}`}
                      </span>
                      <span>{deliveryStatusLabel(delivery.status)}</span>
                      <span>{new Date(delivery.createdAt).toLocaleString()}</span>
                      {delivery.error && <span className="break-words text-muted-foreground/90">— {delivery.error}</span>}
                      {delivery.diagnostic && (
                        <span className="basis-full break-words text-foreground/80">
                          Action: {delivery.diagnostic.recoveryAction}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {event.channel === "sms" && event.deliveryAttempts.length === 0 && event.deliveryError && (
                <div className="mt-1 text-[11px] text-muted-foreground/90">
                  <p>— {event.deliveryError}</p>
                  {event.deliveryDiagnostic && (
                    <p className="mt-1 text-foreground/80">Action: {event.deliveryDiagnostic.recoveryAction}</p>
                  )}
                </div>
              )}
          </div>
         )) : <p className="text-xs text-muted-foreground">Triggered rules will appear here. SMS is only attempted for rules that opt in.</p>}
      </div>
    </section>
  );
}