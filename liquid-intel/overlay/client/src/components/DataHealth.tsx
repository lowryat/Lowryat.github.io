import type { ReactNode } from "react";
import { AlertTriangle, BellRing, CheckCircle2, Database, HeartPulse, Loader2, Network, Server, XCircle } from "lucide-react";
import { ago, usePipelineHealth, type PipelineHealth } from "@/lib/quant-api";

const STATUS_STYLE: Record<PipelineHealth["status"], { label: string; className: string; icon: ReactNode }> = {
  healthy: { label: "All systems healthy", className: "border-primary/40 bg-primary/10 text-primary", icon: <CheckCircle2 className="h-5 w-5" /> },
  degraded: { label: "Degraded: running with gaps", className: "border-yellow-400/40 bg-yellow-400/10 text-yellow-200", icon: <AlertTriangle className="h-5 w-5" /> },
  down: { label: "Down: core data unavailable", className: "border-destructive/40 bg-destructive/10 text-destructive", icon: <XCircle className="h-5 w-5" /> },
};

function stateClass(state: string | null | undefined): string {
  if (state === "ok" || state === "closed" || state === "ready") return "text-primary";
  if (state === "degraded" || state === "half_open" || state === "partial" || state === "stale" || state === "loading") return "text-yellow-300";
  return "text-destructive";
}

export function DataHealth() {
  const query = usePipelineHealth();
  const health = query.data;
  if (query.isLoading) return <div className="flex min-h-[260px] items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Checking the pipeline…</div>;
  if (!health) return <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-5 text-sm text-destructive">The health endpoint did not respond. The server may be restarting.</div>;

  const status = STATUS_STYLE[health.status];
  const { market, database, dailyHistory, notifications } = health;
  const mainSources = Object.entries(health.sources).filter(([name]) => !name.startsWith("dex:"));
  const dexSources = Object.entries(health.sources).filter(([name]) => name.startsWith("dex:"));

  return (
    <div className="animate-fade-up space-y-5">
      <section className="rounded-xl border border-primary/20 bg-card p-5">
        <div className="flex items-center gap-2 text-primary"><HeartPulse className="h-4 w-4" /><span className="text-[10px] font-semibold uppercase tracking-[0.22em]">Data pipeline</span></div>
        <h1 className="mt-2 font-display text-3xl font-black text-foreground">HEALTH</h1>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">Every sweep, provider, and delivery channel behind the numbers, so a stale or missing value is explained rather than hidden. Updates every 15 seconds.</p>
      </section>

      <section className={`rounded-xl border p-4 ${status.className}`}>
        <div className="flex items-center gap-2 font-semibold">{status.icon}{status.label}<span className="ml-auto text-[10px] font-normal text-muted-foreground">checked {ago(health.checkedAt)}</span></div>
        {health.issues.length > 0 && (
          <ul className="mt-3 space-y-1.5 text-xs">
            {health.issues.map((issue, index) => (
              <li key={`${issue.area}-${index}`} className="flex gap-2 text-foreground/90"><span className={issue.severity === "critical" ? "text-destructive" : "text-yellow-300"}>{issue.severity === "critical" ? "Critical" : "Warning"}</span><span>{issue.message}</span></li>
            ))}
          </ul>
        )}
      </section>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card title="Market sweep" icon={<Server className="h-4 w-4" />}>
          <Rows rows={[
            ["Last success", ago(market.collection.lastSuccessAt)],
            ["Last run", `${market.collection.lastStatus ?? "none"}${market.collection.lastDurationMs != null ? ` in ${(market.collection.lastDurationMs / 1000).toFixed(1)}s` : ""}`],
            ["Runs / ok", `${market.collection.runs} / ${market.collection.ok}`],
            ["Deadline aborts", `${market.collection.timeouts} (limit ${(market.collection.deadlineMs / 1000).toFixed(0)}s)`],
            ["Skipped overlaps", String(market.collection.skippedOverlaps)],
            ["History backfill", `${market.backfill.lastStatus ?? "not run"}${market.lastBackfill ? ` · ${market.lastBackfill.coinsOk}/${market.lastBackfill.coinsTotal} assets` : ""}`],
            ["Next backfill", market.nextBackfillAt ? new Date(market.nextBackfillAt).toLocaleTimeString() : "—"],
          ]} />
        </Card>
        <Card title="Database" icon={<Database className="h-4 w-4" />}>
          <Rows rows={[
            ["Configured", database.configured ? "Yes" : "No (in-memory only)"],
            ["Connections", `${database.totalClients} open · ${database.idleClients} idle · ${database.waitingRequests} waiting (max ${database.maxClients ?? "?"})`],
            ["Write queue", `${market.persistence.pending}/${market.persistence.capacity} pending`],
            ["Writes ok / failed", `${market.persistence.completed} / ${market.persistence.failed}`],
            ["Dropped / timed out", `${market.persistence.dropped} / ${market.persistence.timedOut}`],
            ["Connection errors", `${database.errors}${database.lastErrorAt ? ` · last ${ago(database.lastErrorAt)}` : ""}`],
          ]} />
          {(market.persistence.lastError || database.lastError) && <p className="mt-2 break-words text-[10px] text-yellow-200/80">{market.persistence.lastError ?? database.lastError}</p>}
        </Card>
        <Card title="Alerts and notifications" icon={<BellRing className="h-4 w-4" />}>
          <Rows rows={[
            ["Alert evaluator", health.alerts.enabled ? `${health.alerts.idle ? "idle (no rules)" : "running"} · ${ago(health.alerts.lastSuccessAt)}` : "disabled (no database)"],
            ["SMS", notifications.sms.configured ? `configured · ${notifications.sms.plan.join(" then ")}${notifications.sms.messagingService ? " · Messaging Service" : ""}` : "not configured"],
            ["SMS accepted / delivered", `${notifications.sms.accepted} / ${notifications.sms.delivered}`],
            ["SMS undelivered / failed", `${notifications.sms.undelivered} / ${notifications.sms.failed}`],
            ["Push (ntfy)", notifications.push.configured ? `configured · ${notifications.push.sent} sent · ${notifications.push.failed} failed` : "not configured"],
            ["Coinbase stream", !health.coinbase.started ? "not started" : health.coinbase.lastSuccessAt ? `last message ${ago(health.coinbase.lastSuccessAt)}` : "connecting, no messages yet"],
          ]} />
        </Card>
      </div>

      <Card title="Provider hosts" icon={<Network className="h-4 w-4" />} subtitle="Every request goes through one client that caps concurrency, spaces requests, honors rate limits, and pauses a failing host instead of hammering it.">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-xs">
            <thead className="text-[10px] uppercase tracking-wider text-muted-foreground"><tr><th className="py-2 pr-3">Host</th><th className="px-2">Circuit</th><th className="px-2 text-right">Requests</th><th className="px-2 text-right">Success</th><th className="px-2 text-right">429s</th><th className="px-2 text-right">Timeouts</th><th className="px-2 text-right">p50 / p95</th><th className="px-2">Last error</th></tr></thead>
            <tbody className="divide-y divide-border/60">
              {health.hosts.map((host) => (
                <tr key={host.host}>
                  <td className="py-2 pr-3 font-mono text-foreground">{host.host}</td>
                  <td className={`px-2 ${stateClass(host.circuit)}`}>{host.circuit.replace("_", " ")}{host.cooldownUntil && Date.parse(host.cooldownUntil) > Date.now() ? " · cooling down" : ""}</td>
                  <td className="px-2 text-right font-mono">{host.requests}</td>
                  <td className="px-2 text-right font-mono">{host.requests ? `${Math.round((host.successes / host.requests) * 100)}%` : "—"}</td>
                  <td className="px-2 text-right font-mono">{host.rateLimited}</td>
                  <td className="px-2 text-right font-mono">{host.timeouts}</td>
                  <td className="px-2 text-right font-mono">{host.p50LatencyMs != null ? `${host.p50LatencyMs} / ${host.p95LatencyMs} ms` : "—"}</td>
                  <td className="max-w-[260px] truncate px-2 text-muted-foreground" title={host.lastError ?? ""}>{host.lastError ? `${host.lastError} (${ago(host.lastErrorAt)})` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Live sources" icon={<Server className="h-4 w-4" />}>
          <div className="space-y-2 text-xs">
            {mainSources.map(([name, source]) => (
              <div key={name} className="flex items-start justify-between gap-3 border-b border-border/50 pb-2 last:border-0">
                <div><div className="font-semibold text-foreground">{name}</div>{source.error && <div className="text-[10px] text-yellow-200/80">{source.error}</div>}</div>
                <div className="text-right"><div className={stateClass(source.state)}>{source.state}</div><div className="text-[10px] text-muted-foreground">{ago(source.lastSuccessAt)} · {Math.round(source.completeness * 100)}% complete</div></div>
              </div>
            ))}
            {dexSources.length > 0 && <p className="text-[10px] text-muted-foreground">DEX chains: {dexSources.filter(([, source]) => source.state === "ok").length}/{dexSources.length} reporting.</p>}
          </div>
        </Card>
        <Card title="Daily history" icon={<Database className="h-4 w-4" />} subtitle={`Feeds the Signals and Risk Lab tabs. State: ${dailyHistory.state}. Last live refresh ${ago(dailyHistory.lastRefreshAt)}.${!dailyHistory.lastRefreshAt && dailyHistory.assets.some((row) => row.source === "database") ? " Serving the last stored history until a live refresh succeeds." : ""}`}>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] sm:grid-cols-3">
            {dailyHistory.assets.map((row) => (
              <div key={row.symbol} className="flex justify-between gap-2" title={row.error ?? ""}>
                <span className="font-semibold text-foreground">{row.symbol}</span>
                <span className={row.points ? "text-muted-foreground" : "text-destructive"}>{row.points ? `${row.points}d · ${row.source}` : "missing"}</span>
              </div>
            ))}
          </div>
          <div className="mt-3 space-y-1 text-[11px]">
            {dailyHistory.globals.map((row) => (
              <div key={row.metric} className="flex justify-between gap-2" title={row.error ?? ""}>
                <span className="text-foreground">{row.metric.replace("_", " ")}</span>
                <span className={row.points ? "text-muted-foreground" : "text-destructive"}>{row.points ? `${row.points}d through ${row.lastDate}` : row.error ?? "missing"}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}

function Card({ title, subtitle, icon, children }: { title: string; subtitle?: string; icon?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
      <h2 className="flex items-center gap-2 font-display text-lg font-black text-foreground"><span className="text-primary">{icon}</span>{title}</h2>
      {subtitle && <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{subtitle}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Rows({ rows }: { rows: Array<[string, string]> }) {
  return (
    <dl className="space-y-1.5 text-xs">
      {rows.map(([label, value]) => (
        <div key={label} className="flex justify-between gap-3"><dt className="text-muted-foreground">{label}</dt><dd className="text-right font-mono text-foreground">{value}</dd></div>
      ))}
    </dl>
  );
}
