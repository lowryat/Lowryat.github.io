/**
 * Free phone push notifications through ntfy (https://ntfy.sh), used as a
 * second channel alongside SMS. Push needs no carrier registration, so alerts
 * still reach the phone while an SMS sender is blocked or pending A2P review.
 *
 * Configure with Replit Secrets:
 *   NTFY_TOPIC   an unguessable topic name you subscribe to in the ntfy app
 *   NTFY_SERVER  optional, default https://ntfy.sh
 *   NTFY_TOKEN   optional access token for protected topics
 *
 * Messages are published as JSON, which carries UTF-8 titles safely. Putting
 * an emoji or "·" in an HTTP header (the X-Title style) throws before the
 * request is sent, which silently dropped alerts in the earlier Python bot.
 */

export type PushPriority = "min" | "low" | "default" | "high" | "urgent";

export type PushResult = { sent: boolean; error?: string };

const PRIORITY_VALUE: Record<PushPriority, number> = { min: 1, low: 2, default: 3, high: 4, urgent: 5 };
const PUSH_TIMEOUT_MS = 8_000;

const stats = {
  attempts: 0,
  sent: 0,
  failed: 0,
  lastError: null as string | null,
  lastSentAt: null as string | null,
};

function config() {
  const topic = process.env.NTFY_TOPIC?.trim() || "";
  const server = (process.env.NTFY_SERVER?.trim() || "https://ntfy.sh").replace(/\/+$/, "");
  const token = process.env.NTFY_TOKEN?.trim() || "";
  return { topic, server, token };
}

export function isPushConfigured(): boolean {
  return Boolean(config().topic);
}

export function buildPushPayload(topic: string, title: string, message: string, options: { priority?: PushPriority; tags?: string[]; click?: string } = {}) {
  return {
    topic,
    title: title.slice(0, 250),
    message: message.slice(0, 4_000),
    priority: PRIORITY_VALUE[options.priority ?? "default"],
    ...(options.tags?.length ? { tags: options.tags.slice(0, 5) } : {}),
    ...(options.click ? { click: options.click } : {}),
  };
}

export async function sendPush(
  title: string,
  message: string,
  options: { priority?: PushPriority; tags?: string[]; click?: string; fetcher?: typeof fetch } = {},
): Promise<PushResult> {
  const { topic, server, token } = config();
  if (!topic) return { sent: false, error: "NTFY_TOPIC is not configured." };
  stats.attempts += 1;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PUSH_TIMEOUT_MS);
  timer.unref?.();
  try {
    const fetcher = options.fetcher ?? fetch;
    const response = await fetcher(`${server}/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(buildPushPayload(topic, title, message, options)),
      signal: controller.signal,
    });
    if (!response.ok) {
      stats.failed += 1;
      stats.lastError = `ntfy returned HTTP ${response.status}`;
      return { sent: false, error: stats.lastError };
    }
    stats.sent += 1;
    stats.lastSentAt = new Date().toISOString();
    return { sent: true };
  } catch (error) {
    stats.failed += 1;
    stats.lastError = error instanceof Error && error.name === "AbortError" ? "ntfy request timed out" : "ntfy request failed";
    return { sent: false, error: stats.lastError };
  } finally {
    clearTimeout(timer);
  }
}

/** Fire-and-forget mirror used next to SMS sends. Never throws. */
export function mirrorToPush(title: string, message: string, priority: PushPriority = "high"): void {
  if (!isPushConfigured()) return;
  void sendPush(title, message, { priority, tags: ["chart_with_upwards_trend"] }).catch(() => undefined);
}

export function getPushStats() {
  return { configured: isPushConfigured(), ...stats };
}
