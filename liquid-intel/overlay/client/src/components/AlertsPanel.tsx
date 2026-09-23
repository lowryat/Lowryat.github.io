import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  BellRing,
  Check,
  CheckCircle2,
  Clipboard,
  Code2,
  Loader2,
  MessageSquare,
  Plus,
  Send,
  ShieldAlert,
  Smartphone,
  Stethoscope,
  Trash2,
  UserRound,
  WifiOff,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { Insight } from "@/lib/crypto-utils";
import type { AlertStatus, DeliveryRecord, RollingMetric, SmsDiagnostics } from "@shared/alerts";
import { fetchSmsDiagnostics, sendTestPush } from "@/lib/quant-api";

/** "sent" only means Twilio accepted the message; the carrier receipt decides delivery. */
const DELIVERY_STATE: Record<DeliveryRecord["status"], { dot: string; label: string }> = {
  pending: { dot: "bg-muted-foreground", label: "Sending" },
  sent: { dot: "bg-[#6e9eff]", label: "Accepted by Twilio, awaiting carrier receipt" },
  delivered: { dot: "bg-primary", label: "Delivered to phone" },
  undelivered: { dot: "bg-destructive", label: "Not delivered by carrier" },
  failed: { dot: "bg-destructive", label: "Failed" },
};

function pineTemplate(ownerToken?: string) {
  const token = ownerToken || "LOAD_ALERTS_TO_GET_YOUR_OWNER_TOKEN";
  return `// LIQ·INTEL TradingView webhook payload
// Configure the alert webhook URL as:
// POST /api/webhooks/tradingview
// Keep the server-configured x-webhook-secret authentication in TradingView.
// This owner token scopes a valid webhook to your private recipient list.
alertPayload = '{"symbol":"' + syminfo.ticker +
  '","event":"strategy_signal","side":"long"' +
  ',"entry":' + str.tostring(strategy.position_avg_price) +
  ',"stop":' + str.tostring(stopPrice) +
  ',"target":' + str.tostring(targetPrice) +
  ',"timeframe":"' + timeframe.period +
  '","strategy":"LIQ·INTEL Pine bridge"' +
  ',"ownerToken":"${token}"}'
alert(alertPayload, alert.freq_once_per_bar_close)`;
}

function formatTime(value: string) {
  return new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function formatMetric(metric: RollingMetric) {
  if (!metric.ready) return `${metric.observations}/${metric.requiredObservations} bars`;
  const rate = metric.rateOfIncreasePerMinute;
  return `${metric.rewardRisk?.toFixed(2)} R/R · ${rate == null ? "—" : `${rate >= 0 ? "+" : ""}${rate.toFixed(3)}/min`}`;
}

export function AlertsPanel({ insights }: { insights: Insight[] }) {
  const [status, setStatus] = useState<AlertStatus | null>(null);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [message, setMessage] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [notice, setNotice] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [diagnostics, setDiagnostics] = useState<SmsDiagnostics | null>(null);
  const [recipientImpact, setRecipientImpact] = useState<{
    id: string;
    name: string;
    action: "disable" | "delete";
    count: number;
    replacementRecipientId: string;
  } | null>(null);

  const enabledRecipients = useMemo(
    () => status?.recipients.filter((recipient) => recipient.enabled) ?? [],
    [status],
  );

  async function refresh() {
    const response = await fetch("/api/alerts", { credentials: "include" });
    if (!response.ok) throw new Error("Could not load alert settings");
    const nextStatus = (await response.json()) as AlertStatus;
    setStatus(nextStatus);
    setSelectedIds((current) => current.filter((id) => nextStatus.recipients.some((recipient) => recipient.id === id)));
  }

  useEffect(() => {
    refresh().catch((error) => setNotice({ type: "error", text: error.message }));
  }, []);

  async function request(path: string, options: RequestInit = {}) {
    const response = await fetch(path, {
      ...options,
      credentials: "include",
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(body.message || "Request failed") as Error & {
        status?: number;
        body?: Record<string, unknown>;
      };
      error.status = response.status;
      error.body = body;
      throw error;
    }
    return body;
  }

  async function addNewRecipient(event: React.FormEvent) {
    event.preventDefault();
    setBusy("recipient");
    setNotice(null);
    try {
      const body = await request("/api/alerts/recipients", {
        method: "POST",
        body: JSON.stringify({ name, phone }),
      });
      setStatus(body as AlertStatus);
      setName("");
      setPhone("");
      setNotice({ type: "success", text: "Recipient added and enabled." });
    } catch (error) {
      setNotice({ type: "error", text: error instanceof Error ? error.message : "Could not add recipient" });
    } finally {
      setBusy(null);
    }
  }

  async function toggleRecipient(
    id: string,
    enabled: boolean,
    confirmedRuleCount?: number,
    replacementRecipientId?: string,
  ) {
    setBusy(`recipient-toggle:${id}`);
    setNotice(null);
    try {
      const body = await request(`/api/alerts/recipients/${id}`, {
        method: "PATCH",
        body: JSON.stringify({
          enabled,
          confirmedAnalysisAlertRuleCount: confirmedRuleCount,
          replacementRecipientId: replacementRecipientId || undefined,
        }),
      });
      setStatus(body as AlertStatus);
      setRecipientImpact(null);
      const reassignedCount = Number(body.reassignedAnalysisRuleCount ?? 0);
      setNotice({
        type: "success",
        text: enabled
          ? "Recipient enabled."
          : reassignedCount > 0
            ? `Recipient disabled. ${reassignedCount} analysis ${reassignedCount === 1 ? "rule was" : "rules were"} reassigned.`
            : "Recipient disabled.",
      });
    } catch (error) {
      const requestError = error as Error & { status?: number; body?: Record<string, unknown> };
      const count = requestError.body?.affectedAnalysisRuleCount;
      const recipient = status?.recipients.find((item) => item.id === id);
      if (!enabled && requestError.status === 409 && typeof count === "number" && recipient) {
        setRecipientImpact((current) => ({
          id,
          name: recipient.name,
          action: "disable",
          count,
          replacementRecipientId: current?.id === id ? current.replacementRecipientId : "",
        }));
        return;
      }
      setNotice({ type: "error", text: error instanceof Error ? error.message : "Could not update recipient" });
    } finally {
      setBusy(null);
    }
  }

  async function removeRecipient(
    id: string,
    confirmedRuleCount?: number,
    replacementRecipientId?: string,
  ) {
    setBusy(`recipient-delete:${id}`);
    setNotice(null);
    try {
      const body = await request(`/api/alerts/recipients/${id}`, {
        method: "DELETE",
        body: JSON.stringify({
          confirmedAnalysisAlertRuleCount: confirmedRuleCount,
          replacementRecipientId: replacementRecipientId || undefined,
        }),
      });
      setStatus(body as AlertStatus);
      setSelectedIds((current) => current.filter((item) => item !== id));
      setRecipientImpact(null);
      const reassignedCount = Number(body.reassignedAnalysisRuleCount ?? 0);
      setNotice({
        type: "success",
        text: reassignedCount > 0
          ? `Recipient deleted. ${reassignedCount} analysis ${reassignedCount === 1 ? "rule was" : "rules were"} reassigned.`
          : "Recipient deleted.",
      });
    } catch (error) {
      const requestError = error as Error & { status?: number; body?: Record<string, unknown> };
      const count = requestError.body?.affectedAnalysisRuleCount;
      const recipient = status?.recipients.find((item) => item.id === id);
      if (requestError.status === 409 && typeof count === "number" && recipient) {
        setRecipientImpact((current) => ({
          id,
          name: recipient.name,
          action: "delete",
          count,
          replacementRecipientId: current?.id === id ? current.replacementRecipientId : "",
        }));
        return;
      }
      setNotice({ type: "error", text: error instanceof Error ? error.message : "Could not remove recipient" });
    } finally {
      setBusy(null);
    }
  }

  async function updateSetting(key: "insightAlertsEnabled" | "tradingviewAlertsEnabled", value: boolean) {
    if (!status) return;
    try {
      const body = await request("/api/alerts/settings", {
        method: "PATCH",
        body: JSON.stringify({ [key]: value }),
      });
      setStatus(body as AlertStatus);
    } catch (error) {
      setNotice({ type: "error", text: error instanceof Error ? error.message : "Could not update alert setting" });
    }
  }

  async function sendAlert(payload: Record<string, unknown>, action: string) {
    setBusy(action);
    setNotice(null);
    try {
      const body = await request("/api/alerts/send", {
        method: "POST",
        body: JSON.stringify({ ...payload, recipientIds: selectedIds.length ? selectedIds : undefined }),
      });
      setStatus(body.status as AlertStatus);
      setNotice({
        type: body.status.providerConfigured ? "success" : "error",
        text: body.message,
      });
    } catch (error) {
      setNotice({ type: "error", text: error instanceof Error ? error.message : "Could not send alert" });
    } finally {
      setBusy(null);
    }
  }

  async function runDiagnostics() {
    setBusy("diagnostics");
    try {
      setDiagnostics(await fetchSmsDiagnostics());
    } catch (error) {
      setNotice({ type: "error", text: error instanceof Error ? error.message : "Diagnostics are unavailable" });
    } finally {
      setBusy(null);
    }
  }

  async function testPush() {
    setBusy("push");
    try {
      const body = await sendTestPush();
      setNotice({ type: "success", text: body.message });
    } catch (error) {
      setNotice({ type: "error", text: error instanceof Error ? error.message : "Test push failed" });
    } finally {
      setBusy(null);
    }
  }

  async function copyTemplate() {
    await navigator.clipboard.writeText(pineTemplate(status?.tradingViewWebhookToken));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  return (
    <div className="animate-fade-up space-y-6">
      <AlertDialog open={recipientImpact !== null} onOpenChange={(open) => !open && setRecipientImpact(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {recipientImpact?.action === "delete" ? "Delete" : "Disable"} this recipient?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {recipientImpact
                ? `${recipientImpact.count} enabled analysis ${recipientImpact.count === 1 ? "rule uses" : "rules use"} ${recipientImpact.name}. ${recipientImpact.action === "delete" ? "Deleting" : "Disabling"} this recipient will interrupt SMS delivery for ${recipientImpact.count === 1 ? "that rule" : "those rules"}.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {recipientImpact && enabledRecipients.some((recipient) => recipient.id !== recipientImpact.id) ? (
            <div className="space-y-2">
              <label htmlFor="replacement-recipient" className="text-sm font-medium">
                Move enabled SMS rules to
              </label>
              <select
                id="replacement-recipient"
                value={recipientImpact.replacementRecipientId}
                onChange={(event) => setRecipientImpact((current) => current
                  ? { ...current, replacementRecipientId: event.target.value }
                  : current)}
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="">Do not move rules</option>
                {enabledRecipients
                  .filter((recipient) => recipient.id !== recipientImpact.id)
                  .map((recipient) => (
                    <option key={recipient.id} value={recipient.id}>{recipient.name}</option>
                  ))}
              </select>
              <p className="text-xs text-muted-foreground">
                Choose an enabled recipient to keep these alerts delivering.
              </p>
            </div>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel>Keep recipient</AlertDialogCancel>
            <AlertDialogAction
              disabled={Boolean(recipientImpact && busy === `${recipientImpact.action === "delete" ? "recipient-delete" : "recipient-toggle"}:${recipientImpact.id}`)}
              onClick={() => {
                if (!recipientImpact) return;
                if (recipientImpact.action === "delete") {
                  void removeRecipient(
                    recipientImpact.id,
                    recipientImpact.count,
                    recipientImpact.replacementRecipientId,
                  );
                } else {
                  void toggleRecipient(
                    recipientImpact.id,
                    false,
                    recipientImpact.count,
                    recipientImpact.replacementRecipientId,
                  );
                }
              }}
            >
              {recipientImpact && busy === `${recipientImpact.action === "delete" ? "recipient-delete" : "recipient-toggle"}:${recipientImpact.id}`
                ? <Loader2 className="animate-spin" />
                : null}
              {recipientImpact?.action === "delete" ? "Delete anyway" : "Disable anyway"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <div className="flex items-center gap-2 text-primary">
            <BellRing className="h-5 w-5" />
            <span className="text-[10px] font-semibold uppercase tracking-[0.25em]">Alert control plane</span>
          </div>
          <h1 className="mt-2 font-display text-3xl font-black tracking-tight text-foreground lg:text-4xl">
            SMS + PINE SIGNALS
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Route market intelligence and TradingView strategy events to a controlled recipient list.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <div className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-semibold ${status?.providerConfigured ? "border-primary/30 bg-primary/5 text-primary" : "border-yellow-500/30 bg-yellow-500/5 text-yellow-400"}`}>
            {status?.providerConfigured ? <MessageSquare className="h-4 w-4" /> : <WifiOff className="h-4 w-4" />}
            {status?.providerConfigured ? "TWILIO CONFIGURED" : "TWILIO NOT CONNECTED"}
          </div>
          <div className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-semibold ${status?.pushConfigured ? "border-primary/30 bg-primary/5 text-primary" : "border-border bg-card text-muted-foreground"}`}>
            <Smartphone className="h-4 w-4" />
            {status?.pushConfigured ? "PUSH READY" : "PUSH OFF"}
          </div>
        </div>
      </div>

      {notice && (
        <div className={`flex items-start gap-3 rounded-lg border px-4 py-3 text-sm ${notice.type === "success" ? "border-primary/30 bg-primary/5 text-primary" : "border-yellow-500/30 bg-yellow-500/5 text-yellow-300"}`}>
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{notice.text}</span>
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-[1.15fr_0.85fr]">
        <div className="space-y-6">
          <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
            <div className="mb-4 flex items-center justify-between gap-4">
              <div>
                <div className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Recipients</div>
                <p className="mt-1 text-xs text-muted-foreground">Only enabled recipients receive manual or automatic alerts.</p>
              </div>
              <UserRound className="h-5 w-5 text-secondary" />
            </div>
            <form onSubmit={addNewRecipient} className="grid gap-2 sm:grid-cols-[1fr_1.1fr_auto]">
              <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Display name" aria-label="Recipient name" />
              <Input value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="+14155552671" aria-label="Recipient phone number" />
              <Button type="submit" size="sm" disabled={busy === "recipient"}>
                {busy === "recipient" ? <Loader2 className="animate-spin" /> : <Plus />}
                Add
              </Button>
            </form>
            <div className="mt-4 divide-y divide-border/60">
              {status?.recipients.length ? status.recipients.map((recipient) => (
                <div key={recipient.id} className="flex flex-wrap items-center gap-3 py-3">
                  <input
                    type="checkbox"
                    checked={selectedIds.includes(recipient.id)}
                    onChange={(event) => setSelectedIds((current) => event.target.checked ? [...current, recipient.id] : current.filter((id) => id !== recipient.id))}
                    disabled={!recipient.enabled}
                    className="h-4 w-4 accent-primary"
                    aria-label={`Select ${recipient.name}`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold text-foreground">{recipient.name}</div>
                    <div className="font-mono text-[11px] text-muted-foreground">{recipient.displayPhone}</div>
                  </div>
                  <Switch checked={recipient.enabled} disabled={busy !== null} onCheckedChange={(value) => toggleRecipient(recipient.id, value)} aria-label={`Enable ${recipient.name}`} />
                  <Button type="button" variant="ghost" size="icon" disabled={busy !== null} onClick={() => removeRecipient(recipient.id)} aria-label={`Delete ${recipient.name}`}>
                    {busy === `recipient-delete:${recipient.id}`
                      ? <Loader2 className="h-4 w-4 animate-spin" />
                      : <Trash2 className="h-4 w-4 text-muted-foreground hover:text-destructive" />}
                  </Button>
                </div>
              )) : (
                <div className="py-8 text-center text-xs text-muted-foreground">No recipients configured yet.</div>
              )}
            </div>
            {enabledRecipients.length > 0 && (
              <button type="button" onClick={() => setSelectedIds(selectedIds.length === enabledRecipients.length ? [] : enabledRecipients.map((recipient) => recipient.id))} className="mt-2 text-[11px] font-semibold uppercase tracking-wider text-primary hover:underline">
                {selectedIds.length === enabledRecipients.length ? "Clear selection" : "Select all enabled"}
              </button>
            )}
          </section>

          <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
            <div className="mb-4 flex items-center gap-2">
              <Send className="h-4 w-4 text-primary" />
              <div className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Manual dispatch</div>
            </div>
            <Textarea value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Write a concise market alert..." maxLength={1600} className="min-h-[110px] resize-y" />
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <span className="font-mono text-[10px] text-muted-foreground">
                {message.length}/1600 · {selectedIds.length ? `Sending to ${selectedIds.length} selected` : `Sending to all ${enabledRecipients.length} enabled`}
              </span>
              <Button onClick={() => sendAlert({ message }, "custom")} disabled={!message.trim() || busy !== null}>
                {busy === "custom" ? <Loader2 className="animate-spin" /> : <Send />}
                Send SMS
              </Button>
            </div>
            <div className="mt-6 border-t border-border/60 pt-4">
              <div className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Send an insight</div>
              <div className="space-y-2">
                {insights.slice(0, 3).map((insight, index) => (
                  <button key={`${insight.hl}-${index}`} type="button" onClick={() => sendAlert({ insight: { headline: insight.hl, detail: insight.dt }, dedupeKey: `insight:${insight.hl}` }, `insight-${index}`)} disabled={busy !== null} className="flex w-full items-center gap-3 rounded-lg border border-border p-3 text-left transition-colors hover:border-primary/30 hover:bg-primary/5 disabled:opacity-50">
                    <span className={`h-2 w-2 shrink-0 rounded-full ${insight.tp === "bear" ? "bg-destructive" : insight.tp === "bull" ? "bg-primary" : "bg-[#627EEA]"}`} />
                    <span className="line-clamp-2 flex-1 text-xs font-semibold text-foreground">{insight.hl}</span>
                    <Send className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  </button>
                ))}
              </div>
            </div>
          </section>
        </div>

        <div className="space-y-6">
          <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
            <div className="mb-4 text-xs font-semibold uppercase tracking-widest text-muted-foreground">Automation gates</div>
            <div className="space-y-4">
              {[
                { key: "insightAlertsEnabled" as const, title: "Market intelligence", description: "Allow selected insights to trigger SMS." },
                { key: "tradingviewAlertsEnabled" as const, title: "TradingView / Pine", description: "Send validated webhook events to enabled recipients." },
              ].map((item) => (
                <div key={item.key} className="flex items-center justify-between gap-4 rounded-lg border border-border/60 bg-background/40 p-3">
                  <div>
                    <div className="text-sm font-semibold text-foreground">{item.title}</div>
                    <div className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{item.description}</div>
                  </div>
                  <Switch checked={Boolean(status?.settings[item.key])} onCheckedChange={(value) => updateSetting(item.key, value)} aria-label={`Toggle ${item.title}`} />
                </div>
              ))}
              <label className="block">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Cooldown seconds</span>
                <Input
                  type="number"
                  min={0}
                  max={86400}
                  value={status?.settings.cooldownSeconds ?? 300}
                  onChange={(event) => request("/api/alerts/settings", { method: "PATCH", body: JSON.stringify({ cooldownSeconds: Number(event.target.value) }) }).then((body) => setStatus(body as AlertStatus)).catch((error) => setNotice({ type: "error", text: error.message }))}
                  className="mt-2 font-mono"
                />
              </label>
            </div>
          </section>

          <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
            <div className="mb-4 flex items-center gap-2">
              <Code2 className="h-4 w-4 text-primary" />
              <div className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Pine bridge</div>
            </div>
            <p className="mb-3 text-xs leading-relaxed text-muted-foreground">Post this payload from a TradingView alert to build the 30-second × 60-bar metric.</p>
            <Textarea readOnly value={pineTemplate(status?.tradingViewWebhookToken)} className="min-h-[220px] resize-none font-mono text-[10px] leading-relaxed text-primary/80" />
            <Button type="button" variant="outline" size="sm" onClick={copyTemplate} className="mt-3">
              {copied ? <Check /> : <Clipboard />}
              {copied ? "Copied" : "Copy Pine template"}
            </Button>
            <div className="mt-5 space-y-2">
              {(status?.metrics ?? []).length ? status!.metrics.map((metric) => (
                <div key={metric.symbol} className="flex items-center justify-between gap-3 rounded-lg border border-border/60 p-3">
                  <div className="font-mono text-xs font-semibold text-foreground">{metric.symbol}</div>
                  <div className={`text-right font-mono text-[10px] ${metric.ready ? "text-primary" : "text-muted-foreground"}`}>{formatMetric(metric)}</div>
                </div>
              )) : (
                <div className="rounded-lg border border-dashed border-border p-4 text-center text-[11px] text-muted-foreground">Waiting for BTCUSD, ETHUSD, or stock strategy events.</div>
              )}
            </div>
          </section>

          <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground"><Stethoscope className="h-4 w-4 text-primary" />Delivery diagnostics</div>
              <div className="flex gap-2">
                <Button type="button" size="sm" variant="outline" onClick={runDiagnostics} disabled={busy !== null}>
                  {busy === "diagnostics" ? <Loader2 className="animate-spin" /> : <Stethoscope />}Check SMS setup
                </Button>
                <Button type="button" size="sm" variant="outline" onClick={testPush} disabled={busy !== null || !status?.pushConfigured} title={status?.pushConfigured ? "Send a test push notification" : "Set NTFY_TOPIC to enable push"}>
                  {busy === "push" ? <Loader2 className="animate-spin" /> : <Smartphone />}Test push
                </Button>
              </div>
            </div>
            {diagnostics ? (
              <ul className="space-y-2">
                {diagnostics.checks.map((check) => (
                  <li key={check.id} className="flex gap-2 text-xs">
                    {check.state === "ok" ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" /> : check.state === "warn" ? <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-yellow-400" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />}
                    <div>
                      <div className="font-semibold text-foreground">{check.title}</div>
                      <div className="text-[11px] text-muted-foreground">{check.detail}</div>
                      {check.action && <div className="mt-0.5 text-[11px] text-foreground/80">Fix: {check.action}</div>}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[11px] leading-relaxed text-muted-foreground">Checks the Twilio account, sender number, US A2P 10DLC registration, and recent carrier error codes. It sends no message. {status?.pushConfigured ? "" : "Push is off: set NTFY_TOPIC in Replit Secrets and subscribe to the same topic in the free ntfy app for a backup alert channel."}</p>
            )}
          </section>

          <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
            <div className="mb-3 text-xs font-semibold uppercase tracking-widest text-muted-foreground">Recent delivery log</div>
            {status?.deliveries.length ? status.deliveries.slice(0, 5).map((delivery) => (
              <div key={delivery.id} className="flex items-start gap-3 border-b border-border/50 py-3 last:border-0">
                <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${DELIVERY_STATE[delivery.status]?.dot ?? "bg-destructive"}`} title={DELIVERY_STATE[delivery.status]?.label} />
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-semibold text-foreground">{delivery.recipientName} <span className="font-normal text-muted-foreground">· {formatTime(delivery.createdAt)} · {DELIVERY_STATE[delivery.status]?.label ?? delivery.status}</span></div>
                  <div className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">{delivery.error || delivery.preview}</div>
                </div>
              </div>
            )) : <div className="py-5 text-center text-[11px] text-muted-foreground">No dispatches yet.</div>}
          </section>
        </div>
      </div>
    </div>
  );
}