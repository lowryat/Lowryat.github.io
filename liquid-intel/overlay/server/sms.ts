import { ReplitConnectors } from "@replit/connectors-sdk";

/**
 * Twilio SMS delivery with verified outcomes.
 *
 * Fixes relative to the previous version:
 *  1. Explicit TWILIO_* secrets are preferred over the managed Replit
 *     connector (whose proxy can reject runtime identity), with fallback
 *     between the two when one path is unavailable.
 *  2. A timed-out request is actually cancelled (AbortSignal on both paths)
 *     so a "failed" send cannot still go out later and double-send on retry.
 *  3. HTTP 201 from Twilio only means "queued". Each accepted message is
 *     polled until the carrier reports delivered / undelivered / failed, and
 *     the asynchronous carrier codes (30034 unregistered 10DLC, 30032
 *     unverified toll-free, 30007 carrier filtering, ...) are explained.
 *  4. Messaging Service senders (required for registered A2P 10DLC traffic)
 *     are supported through TWILIO_MESSAGING_SERVICE_SID.
 *  5. Bodies are normalized to the GSM-7 alphabet so one stray "·" or em dash
 *     no longer switches the whole message to 70-character UCS-2 segments.
 *  6. The managed path caches account and sender discovery for ten minutes
 *     instead of issuing two extra API calls before every message.
 */

export type SmsResult = {
  sent: boolean;
  error?: string;
  failure?: SmsFailure;
  /** Twilio Message SID when the message was accepted. */
  sid?: string;
};

export const SMS_REQUEST_TIMEOUT_MS = 10_000;

export type SmsFailureCategory =
  | "provider_unavailable"
  | "sender_rejected"
  | "recipient_rejected";

export type SmsFailure = {
  category: SmsFailureCategory;
  message: string;
  recoveryAction: string;
};

export type SendSmsOptions = {
  timeoutMs?: number;
};

export type SmsDeliveryStatus = "sent" | "delivered" | "undelivered" | "failed";

export type SmsDeliveryUpdate = {
  status: SmsDeliveryStatus;
  providerStatus: string;
  errorCode: number | null;
  /** Safe, explained failure text (never raw provider payloads). */
  error: string | null;
  failure: SmsFailure | null;
  final: boolean;
};

type TwilioAccount = {
  sid?: string;
  status?: string;
  type?: string;
  friendly_name?: string;
};

type TwilioPhoneNumber = {
  phone_number?: string;
  capabilities?: {
    sms?: boolean;
  };
};

type TwilioError = {
  code?: number;
  message?: string;
};

type TwilioMessage = TwilioError & {
  sid?: string;
  status?: string;
  error_code?: number | null;
};

type PathName = "legacy" | "managed";
type Transport = {
  path: PathName;
  fetch: typeof fetch;
  headers: Record<string, string>;
  accountSid: string;
};

const failureCopy: Record<SmsFailureCategory, Omit<SmsFailure, "category">> = {
  provider_unavailable: {
    message: "Twilio is unavailable right now.",
    recoveryAction: "Reconnect Twilio or try again later.",
  },
  sender_rejected: {
    message: "Twilio rejected the configured sender.",
    recoveryAction: "Check the Twilio sender number and account permissions.",
  },
  recipient_rejected: {
    message: "Twilio rejected the recipient.",
    recoveryAction: "Check the recipient number, country access, and SMS opt-in.",
  },
};

/**
 * Specific, provider-independent guidance for the Twilio error codes that
 * account for nearly all real-world SMS failures. Each message embeds its
 * code in parentheses so a persisted error can be re-explained later.
 */
const TWILIO_ERROR_GUIDE: Record<number, SmsFailure> = {
  20003: { category: "sender_rejected", message: "Twilio rejected the account credentials (20003).", recoveryAction: "Re-enter TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN, or reconnect the Replit Twilio integration." },
  20429: { category: "provider_unavailable", message: "Twilio rate-limited this account (20429).", recoveryAction: "Wait a minute and retry; reduce alert frequency or raise the cooldown." },
  21211: { category: "recipient_rejected", message: "The recipient is not a valid phone number (21211).", recoveryAction: "Re-enter the number in E.164 format, for example +14155552671." },
  21408: { category: "recipient_rejected", message: "SMS to this country is disabled on the Twilio account (21408).", recoveryAction: "Enable the country in Twilio Console > Messaging > Settings > Geo permissions." },
  21606: { category: "sender_rejected", message: "The sender number cannot send SMS for this account (21606).", recoveryAction: "Use an SMS-capable number owned by this Twilio account, or set TWILIO_MESSAGING_SERVICE_SID." },
  21608: { category: "recipient_rejected", message: "Twilio trial accounts can only text verified numbers (21608).", recoveryAction: "Verify this number in Twilio Console > Phone Numbers > Verified Caller IDs, or upgrade the Twilio account." },
  21610: { category: "recipient_rejected", message: "The recipient replied STOP and has opted out (21610).", recoveryAction: "Ask the recipient to text START to your Twilio number, then retry." },
  21612: { category: "sender_rejected", message: "The sender cannot reach this destination (21612).", recoveryAction: "Use a sender with the right country capability, or a Messaging Service." },
  21614: { category: "recipient_rejected", message: "The recipient cannot receive SMS (landline or VoIP) (21614).", recoveryAction: "Use a mobile phone number." },
  21617: { category: "sender_rejected", message: "The alert exceeded Twilio's 1,600-character limit (21617).", recoveryAction: "Shorten the alert text." },
  21660: { category: "sender_rejected", message: "The sender number does not belong to this Twilio account (21660).", recoveryAction: "Set TWILIO_FROM_NUMBER to a number owned by the configured account." },
  30001: { category: "provider_unavailable", message: "Twilio's sending queue overflowed (30001).", recoveryAction: "Retry later and reduce burst sends." },
  30002: { category: "sender_rejected", message: "The Twilio account is suspended (30002).", recoveryAction: "Resolve the suspension in Twilio Console." },
  30003: { category: "recipient_rejected", message: "The recipient's phone was unreachable (30003).", recoveryAction: "Check the phone is on with signal, then retry." },
  30004: { category: "recipient_rejected", message: "The recipient or their carrier blocked the message (30004).", recoveryAction: "Ask the recipient to check message-blocking settings." },
  30005: { category: "recipient_rejected", message: "The destination number does not exist (30005).", recoveryAction: "Confirm the recipient number." },
  30006: { category: "recipient_rejected", message: "The destination is a landline or cannot receive SMS (30006).", recoveryAction: "Use a mobile phone number." },
  30007: { category: "sender_rejected", message: "Carrier filtering blocked the message as possible spam (30007).", recoveryAction: "Register the sender (A2P 10DLC or toll-free verification) and avoid link shorteners." },
  30008: { category: "provider_unavailable", message: "The carrier reported an unknown delivery error (30008).", recoveryAction: "Retry; if it repeats, contact Twilio support with the message SID." },
  30032: { category: "sender_rejected", message: "US carriers blocked this toll-free sender because it is not verified (30032).", recoveryAction: "Submit toll-free verification in Twilio Console > Messaging > Regulatory Compliance." },
  30034: { category: "sender_rejected", message: "US carriers blocked this message: the sending number is not registered for A2P 10DLC (30034).", recoveryAction: "Register a Brand and Campaign in Twilio Console > Messaging > Regulatory Compliance, add the number to that Messaging Service, and set TWILIO_MESSAGING_SERVICE_SID." },
};

/** Codes the previous implementation classified at request time; kept for compatibility. */
const LEGACY_RECIPIENT_CODES = [21608, 21610, 21614, 21408, 21211];
const LEGACY_SENDER_CODES = [21606, 21612, 21613, 21617, 30003, 30005];

function smsFailure(category: SmsFailureCategory): SmsFailure {
  return { category, ...failureCopy[category] };
}

export function explainTwilioCode(code: number | null | undefined): SmsFailure | null {
  if (code == null) return null;
  const guide = TWILIO_ERROR_GUIDE[code];
  return guide ? { ...guide } : null;
}

function hasManagedConnectorRuntime(): boolean {
  return Boolean(
    process.env.REPLIT_CONNECTORS_HOSTNAME
      && (
        process.env.REPL_IDENTITY
        || process.env.REPLIT_DEPLOYMENT_ID
        || process.env.REPLIT_DEPLOYMENT_ENVIRONMENT
        || process.env.WEB_REPL_RENEWAL
      ),
  );
}

function legacyConfig() {
  return {
    accountSid: process.env.TWILIO_ACCOUNT_SID?.trim() || "",
    authToken: process.env.TWILIO_AUTH_TOKEN?.trim() || "",
    from: process.env.TWILIO_FROM_NUMBER?.trim() || "",
    messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID?.trim() || "",
  };
}

function hasLegacySecrets(): boolean {
  const config = legacyConfig();
  return Boolean(config.accountSid && config.authToken && (config.from || config.messagingServiceSid));
}

export function isSmsProviderConfigured(): boolean {
  return hasManagedConnectorRuntime() || hasLegacySecrets();
}

/** Explicit secrets first: they are deterministic and verifiable from the running app. */
export function smsProviderPlan(): PathName[] {
  const plan: PathName[] = [];
  if (hasLegacySecrets()) plan.push("legacy");
  if (hasManagedConnectorRuntime()) plan.push("managed");
  return plan;
}

function safeTwilioFailure(body: TwilioError, fallbackCategory: SmsFailureCategory): SmsFailure {
  const code = body.code ?? 0;
  // 30003/30005 are asynchronous carrier codes; the earlier release classified
  // them as sender problems when a request failed with them, and that copy is kept.
  if (code === 30003 || code === 30005) return smsFailure("sender_rejected");
  const specific = explainTwilioCode(code);
  if (specific) return specific;
  if (LEGACY_RECIPIENT_CODES.includes(code)) return smsFailure("recipient_rejected");
  if (LEGACY_SENDER_CODES.includes(code)) return smsFailure("sender_rejected");
  return smsFailure(fallbackCategory);
}

function resultFromFailure(failure: SmsFailure): SmsResult {
  return { sent: false, error: failure.message, failure };
}

/**
 * Converts current normalized failures and older persisted safe messages into
 * the public diagnostic shape. Provider-supplied text is never returned.
 */
export function normalizeSmsFailure(error: string | null | undefined, failure?: SmsFailure): SmsFailure | null {
  if (failure) return { ...failure };
  if (!error) return null;
  const code = /\((\d{5})\)/.exec(error)?.[1];
  const explained = code ? explainTwilioCode(Number(code)) : null;
  if (explained) return explained;
  const lower = error.toLowerCase();
  const category: SmsFailureCategory = lower.includes("recipient")
    || lower.includes("destination")
    || lower.includes("opted out")
    || lower.includes("country")
    || lower.includes("mobile number")
    || lower.includes("trial mode")
    ? "recipient_rejected"
    : lower.includes("sender")
      || lower.includes("messaging account")
      || lower.includes("sms-capable")
      || lower.includes("account permissions")
      ? "sender_rejected"
      : "provider_unavailable";
  return smsFailure(category);
}

const GSM_REPLACEMENTS: Array<[RegExp, string]> = [
  [/[·•‧∙]/g, "-"],
  [/[‐-―−]/g, "-"],
  [/[‘’‚‛′]/g, "'"],
  [/[“”„‟″]/g, "\""],
  [/…/g, "..."],
  [/→/g, "->"],
  [/←/g, "<-"],
  [/≥/g, ">="],
  [/≤/g, "<="],
  [/±/g, "+/-"],
  [/×/g, "x"],
  [/[     ]/g, " "],
  [/[↑▲]/g, "up"],
  [/[↓▼]/g, "down"],
];

/**
 * Normalize an alert to the GSM-7 alphabet where possible. A single non-GSM
 * character forces UCS-2 encoding for the whole message, cutting each segment
 * from 160 to 70 characters and tripling cost; emoji are removed outright.
 */
export function normalizeSmsText(body: string): string {
  let text = body;
  for (const [pattern, replacement] of GSM_REPLACEMENTS) text = text.replace(pattern, replacement);
  text = text
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/[​-‍︎️]/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  return text.length > 1600 ? `${text.slice(0, 1597)}...` : text;
}

async function readJson<T>(response: Response): Promise<T> {
  return await response.json().catch(() => ({})) as T;
}

function legacyTransport(): Transport | null {
  const config = legacyConfig();
  if (!config.accountSid || !config.authToken) return null;
  return {
    path: "legacy",
    fetch: (input, init) => fetch(input, init),
    headers: { Authorization: `Basic ${Buffer.from(`${config.accountSid}:${config.authToken}`).toString("base64")}` },
    accountSid: config.accountSid,
  };
}

let managedDiscovery: { accountSid: string; from: string | null; expiresAt: number } | null = null;
const MANAGED_DISCOVERY_TTL_MS = 10 * 60_000;

async function managedTransport(signal: AbortSignal): Promise<{ transport: Transport; from: string | null } | SmsFailure> {
  const connectors = new ReplitConnectors();
  const proxyFetch = connectors.createProxyFetch("twilio");
  const base: Omit<Transport, "accountSid"> = { path: "managed", fetch: proxyFetch, headers: {} };
  if (managedDiscovery && managedDiscovery.expiresAt > Date.now()) {
    return { transport: { ...base, accountSid: managedDiscovery.accountSid }, from: managedDiscovery.from };
  }
  const accountResponse = await proxyFetch("https://api.twilio.com/2010-04-01/Accounts.json?Status=active&PageSize=20", { method: "GET", signal });
  const accountBody = await readJson<{ accounts?: TwilioAccount[] } & TwilioError>(accountResponse);
  if (!accountResponse.ok) return safeTwilioFailure(accountBody, "provider_unavailable");
  const accountSid = accountBody.accounts?.find((account) => account.status === "active" && account.sid)?.sid;
  if (!accountSid) return smsFailure("sender_rejected");
  let from: string | null = process.env.TWILIO_FROM_NUMBER?.trim() || null;
  if (!from && !process.env.TWILIO_MESSAGING_SERVICE_SID) {
    const numberResponse = await proxyFetch(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/IncomingPhoneNumbers.json?PageSize=50`,
      { method: "GET", signal },
    );
    const numberBody = await readJson<{ incoming_phone_numbers?: TwilioPhoneNumber[] } & TwilioError>(numberResponse);
    if (!numberResponse.ok) return safeTwilioFailure(numberBody, "sender_rejected");
    from = numberBody.incoming_phone_numbers?.find(
      (number) => number.capabilities?.sms === true && number.phone_number,
    )?.phone_number ?? null;
    if (!from) return smsFailure("sender_rejected");
  }
  managedDiscovery = { accountSid, from, expiresAt: Date.now() + MANAGED_DISCOVERY_TTL_MS };
  return { transport: { ...base, accountSid }, from };
}

/** Remembers how each accepted message was sent so its status can be polled. */
const sentTransports = new Map<string, Transport>();
const smsStats = {
  attempts: 0,
  accepted: 0,
  failed: 0,
  delivered: 0,
  undelivered: 0,
  byPath: { legacy: 0, managed: 0 } as Record<PathName, number>,
  recentFailures: [] as Array<{ at: string; code: number | null; category: SmsFailureCategory; message: string }>,
  lastAcceptedAt: null as string | null,
};

function recordFailure(failure: SmsFailure, code: number | null) {
  smsStats.recentFailures.unshift({ at: new Date().toISOString(), code, category: failure.category, message: failure.message });
  smsStats.recentFailures.length = Math.min(smsStats.recentFailures.length, 25);
}

async function sendVia(pathName: PathName, to: string, body: string, signal: AbortSignal): Promise<SmsResult> {
  let transport: Transport;
  let from: string | null;
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID?.trim() || "";
  if (pathName === "legacy") {
    const legacy = legacyTransport();
    const config = legacyConfig();
    if (!legacy || !(config.from || config.messagingServiceSid)) return resultFromFailure(smsFailure("provider_unavailable"));
    transport = legacy;
    from = config.from || null;
  } else {
    const managed = await managedTransport(signal);
    if ("category" in managed) return resultFromFailure(managed);
    transport = managed.transport;
    from = managed.from;
  }
  const params = new URLSearchParams({ To: to, Body: body });
  if (messagingServiceSid) params.set("MessagingServiceSid", messagingServiceSid);
  else if (from) params.set("From", from);
  else return resultFromFailure(smsFailure("sender_rejected"));

  const response = await transport.fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(transport.accountSid)}/Messages.json`,
    {
      method: "POST",
      headers: { ...transport.headers, "Content-Type": "application/x-www-form-urlencoded" },
      body: params,
      signal,
    },
  );
  if (response.ok) {
    const message = await readJson<TwilioMessage>(response);
    smsStats.byPath[pathName] += 1;
    if (message.sid) {
      sentTransports.set(message.sid, transport);
      while (sentTransports.size > 500) sentTransports.delete(sentTransports.keys().next().value as string);
      return { sent: true, sid: message.sid };
    }
    return { sent: true };
  }
  const responseBody = await readJson<TwilioError>(response);
  if (response.status === 401 && pathName === "managed") managedDiscovery = null;
  return resultFromFailure(safeTwilioFailure(responseBody, "sender_rejected"));
}

export async function sendSms(to: string, body: string, options: SendSmsOptions = {}): Promise<SmsResult> {
  const timeoutMs = options.timeoutMs ?? SMS_REQUEST_TIMEOUT_MS;
  const plan = smsProviderPlan();
  smsStats.attempts += 1;
  if (!plan.length) {
    const failure = smsFailure("provider_unavailable");
    smsStats.failed += 1;
    recordFailure(failure, null);
    return resultFromFailure(failure);
  }
  const text = normalizeSmsText(body);
  let last: SmsResult = resultFromFailure(smsFailure("provider_unavailable"));
  for (const pathName of plan) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      last = await sendVia(pathName, to, text, controller.signal);
    } catch {
      // Timeouts and network errors are not retried on the same path: Twilio
      // may already have accepted the POST, and a blind retry double-sends.
      last = resultFromFailure(smsFailure("provider_unavailable"));
    } finally {
      clearTimeout(timer);
    }
    if (last.sent) break;
    // Only fall back to the other path when this one could not be used at all.
    const reason = last.failure;
    const pathUnusable = reason?.category === "provider_unavailable"
      || reason?.message.includes("(20003)");
    if (!pathUnusable) break;
  }
  if (last.sent) {
    smsStats.accepted += 1;
    smsStats.lastAcceptedAt = new Date().toISOString();
  } else {
    smsStats.failed += 1;
    if (last.failure) recordFailure(last.failure, Number(/\((\d{5})\)/.exec(last.failure.message)?.[1]) || null);
  }
  return last;
}

const FINAL_STATUSES = new Set(["delivered", "undelivered", "failed", "read", "canceled"]);
const DEFAULT_TRACKING_SCHEDULE_MS = [4_000, 12_000, 30_000, 60_000, 120_000, 300_000];

function deliveryUpdateFrom(message: TwilioMessage): SmsDeliveryUpdate | null {
  const providerStatus = typeof message.status === "string" ? message.status : null;
  if (!providerStatus) return null;
  const errorCode = typeof message.error_code === "number" ? message.error_code : null;
  if (providerStatus === "delivered" || providerStatus === "read") {
    return { status: "delivered", providerStatus, errorCode: null, error: null, failure: null, final: true };
  }
  if (providerStatus === "undelivered" || providerStatus === "failed" || providerStatus === "canceled") {
    const failure = explainTwilioCode(errorCode)
      ?? { ...smsFailure("recipient_rejected"), message: `The carrier did not deliver the message${errorCode ? ` (${errorCode})` : ""}.` };
    return {
      status: providerStatus === "failed" ? "failed" : "undelivered",
      providerStatus,
      errorCode,
      error: failure.message,
      failure,
      final: true,
    };
  }
  return { status: "sent", providerStatus, errorCode, error: null, failure: null, final: false };
}

export async function fetchSmsStatus(sid: string, signal?: AbortSignal): Promise<SmsDeliveryUpdate | null> {
  const transport = sentTransports.get(sid) ?? legacyTransport();
  if (!transport) return null;
  const response = await transport.fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(transport.accountSid)}/Messages/${encodeURIComponent(sid)}.json`,
    { method: "GET", headers: transport.headers, signal },
  );
  if (!response.ok) return null;
  return deliveryUpdateFrom(await readJson<TwilioMessage>(response));
}

/**
 * Poll an accepted message until the carrier reports a final state. Updates
 * are delivered to `onUpdate` whenever the status changes. Timers are unref'd
 * and errors are contained; tracking can never crash or block the server.
 */
export function trackSmsDelivery(
  sid: string,
  onUpdate: (update: SmsDeliveryUpdate) => void | Promise<void>,
  schedule: number[] = DEFAULT_TRACKING_SCHEDULE_MS,
): void {
  let index = 0;
  let lastStatus: string | null = null;
  const tick = () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SMS_REQUEST_TIMEOUT_MS);
    timeout.unref?.();
    void fetchSmsStatus(sid, controller.signal)
      .then(async (update) => {
        if (!update) return false;
        if (update.status !== lastStatus) {
          lastStatus = update.status;
          if (update.final) {
            if (update.status === "delivered") smsStats.delivered += 1;
            else {
              smsStats.undelivered += 1;
              if (update.failure) recordFailure(update.failure, update.errorCode);
            }
          }
          await onUpdate(update);
        }
        return update.final;
      })
      .catch(() => false)
      .then((final) => {
        clearTimeout(timeout);
        index += 1;
        if (!final && index < schedule.length) {
          const next = setTimeout(tick, schedule[index] - (schedule[index - 1] ?? 0));
          next.unref?.();
        }
      });
  };
  const first = setTimeout(tick, schedule[0] ?? 0);
  first.unref?.();
}

export function getSmsStats() {
  return {
    plan: smsProviderPlan(),
    configured: isSmsProviderConfigured(),
    messagingService: Boolean(process.env.TWILIO_MESSAGING_SERVICE_SID?.trim()),
    ...smsStats,
    byPath: { ...smsStats.byPath },
    recentFailures: smsStats.recentFailures.slice(0, 10),
  };
}

export type SmsDiagnosticCheck = {
  id: string;
  state: "ok" | "warn" | "fail";
  title: string;
  detail: string;
  action: string | null;
};

const TOLL_FREE_PREFIXES = ["+1800", "+1833", "+1844", "+1855", "+1866", "+1877", "+1888"];

/**
 * Read-only checks that explain why texts do or do not arrive. Nothing here
 * sends a message; it only reads account, sender, and recent-outcome state.
 */
export async function diagnoseSmsProvider(): Promise<SmsDiagnosticCheck[]> {
  const checks: SmsDiagnosticCheck[] = [];
  const plan = smsProviderPlan();
  const config = legacyConfig();
  checks.push(plan.length
    ? { id: "path", state: "ok", title: "SMS provider configured", detail: `Sending path order: ${plan.map((path) => path === "legacy" ? "your Twilio secrets" : "Replit Twilio connector").join(", then ")}.`, action: null }
    : { id: "path", state: "fail", title: "No SMS provider configured", detail: "Neither TWILIO_* secrets nor a Replit Twilio connection is available to the running app.", action: "Add TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM_NUMBER (or TWILIO_MESSAGING_SERVICE_SID) in Replit Secrets." });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SMS_REQUEST_TIMEOUT_MS);
  timeout.unref?.();
  try {
    if (plan[0] === "legacy") {
      const transport = legacyTransport()!;
      const response = await transport.fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(transport.accountSid)}.json`, { headers: transport.headers, signal: controller.signal });
      const account = await readJson<TwilioAccount & TwilioError>(response);
      if (!response.ok) {
        const failure = safeTwilioFailure(account, "provider_unavailable");
        checks.push({ id: "credentials", state: "fail", title: "Twilio credentials rejected", detail: failure.message, action: failure.recoveryAction });
      } else {
        checks.push({ id: "credentials", state: account.status === "active" ? "ok" : "fail", title: "Twilio account reachable", detail: `Account status: ${account.status ?? "unknown"}.`, action: account.status === "active" ? null : "Reactivate the Twilio account." });
        if (account.type === "Trial") {
          checks.push({ id: "trial", state: "warn", title: "Twilio trial account", detail: "Trial accounts can only text verified numbers and prefix every message with trial text.", action: "Verify each recipient in Twilio Console > Verified Caller IDs, or upgrade the account." });
        }
      }
    } else if (plan[0] === "managed") {
      const managed = await managedTransport(controller.signal);
      checks.push("category" in managed
        ? { id: "credentials", state: "fail", title: "Replit Twilio connector unusable", detail: managed.message, action: `${managed.recoveryAction} Adding TWILIO_* secrets bypasses the connector.` }
        : { id: "credentials", state: "ok", title: "Replit Twilio connector reachable", detail: "The managed connection returned an active account.", action: null });
    }
  } catch (error) {
    checks.push({ id: "credentials", state: "fail", title: "Twilio did not respond", detail: error instanceof Error && error.name === "AbortError" ? "The request timed out." : "The request failed.", action: "Check network access and retry." });
  } finally {
    clearTimeout(timeout);
  }

  const sender = config.messagingServiceSid ? null : config.from || managedDiscovery?.from || null;
  if (config.messagingServiceSid) {
    checks.push({ id: "sender", state: "ok", title: "Messaging Service sender", detail: "Messages are sent through TWILIO_MESSAGING_SERVICE_SID, which is how registered A2P 10DLC traffic is routed.", action: null });
  } else if (sender && sender.startsWith("+1")) {
    const tollFree = TOLL_FREE_PREFIXES.some((prefix) => sender.startsWith(prefix));
    checks.push(tollFree
      ? { id: "sender", state: "warn", title: "US toll-free sender", detail: "Unverified toll-free numbers are blocked by US carriers (error 30032).", action: "Confirm toll-free verification is approved in Twilio Console > Messaging > Regulatory Compliance." }
      : { id: "sender", state: "warn", title: "US 10DLC long-code sender", detail: "Since 2023 US carriers block messages from long codes that are not registered for A2P 10DLC (error 30034). Twilio still returns success when it queues these messages.", action: "Register a Brand and Campaign, attach this number to the campaign's Messaging Service, and set TWILIO_MESSAGING_SERVICE_SID." });
  } else if (sender) {
    checks.push({ id: "sender", state: "ok", title: "Sender number", detail: "A non-US sender is configured; check local sender-ID rules for each destination country.", action: null });
  }

  const byCode = new Map<number, number>();
  for (const failure of smsStats.recentFailures) if (failure.code) byCode.set(failure.code, (byCode.get(failure.code) ?? 0) + 1);
  const worst = Array.from(byCode.entries()).sort((a, b) => b[1] - a[1])[0];
  if (worst) {
    const explained = explainTwilioCode(worst[0]);
    checks.push({ id: "recent", state: "fail", title: `Recent failures: Twilio ${worst[0]} (${worst[1]}x)`, detail: explained?.message ?? "Recent deliveries failed.", action: explained?.recoveryAction ?? null });
  } else if (smsStats.delivered > 0) {
    checks.push({ id: "recent", state: "ok", title: "Recent deliveries confirmed", detail: `${smsStats.delivered} message(s) confirmed delivered since the server started.`, action: null });
  }

  if (!process.env.SESSION_SECRET && !process.env.ANALYSIS_ALERT_COOKIE_SECRET) {
    checks.push({ id: "owner", state: "warn", title: "Alert ownership resets on restart", detail: "SESSION_SECRET is not set, so each server restart issues new owner cookies and your saved recipients and rules stop appearing.", action: "Add a long random SESSION_SECRET in Replit Secrets (Deployments use the same secret)." });
  }
  return checks;
}
