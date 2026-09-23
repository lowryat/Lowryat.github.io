import { z } from "zod";

export const phoneSchema = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{7,14}$/, "Use an E.164 phone number, for example +14155552671");

export const alertRecipientSchema = z.object({
  id: z.string(),
  name: z.string(),
  phone: z.string(),
  displayPhone: z.string(),
  enabled: z.boolean(),
  createdAt: z.string(),
});

export const alertSettingsSchema = z.object({
  insightAlertsEnabled: z.boolean(),
  tradingviewAlertsEnabled: z.boolean(),
  cooldownSeconds: z.number().int().min(0).max(86400),
});

export const deliveryRecordSchema = z.object({
  id: z.string(),
  recipientId: z.string(),
  recipientName: z.string(),
  displayPhone: z.string(),
  preview: z.string(),
  /**
   * "sent" means Twilio accepted the message; "delivered" / "undelivered" are
   * carrier receipts applied later by delivery tracking.
   */
  status: z.enum(["sent", "failed", "pending", "delivered", "undelivered"]),
  error: z.string().nullable(),
  createdAt: z.string(),
});

export const rollingMetricSchema = z.object({
  symbol: z.string(),
  observations: z.number().int().min(0),
  requiredObservations: z.number().int(),
  rewardRisk: z.number().nullable(),
  rateOfIncreasePerMinute: z.number().nullable(),
  lastUpdatedAt: z.string().nullable(),
  ready: z.boolean(),
});

export const alertStatusSchema = z.object({
  provider: z.literal("twilio"),
  providerConfigured: z.boolean(),
  /** True when NTFY_TOPIC is set and alerts are mirrored as phone push notifications. */
  pushConfigured: z.boolean().optional(),
  recipients: z.array(alertRecipientSchema),
  settings: alertSettingsSchema,
  deliveries: z.array(deliveryRecordSchema),
  metrics: z.array(rollingMetricSchema),
  tradingViewWebhookToken: z.string().min(20).optional(),
  affectedAnalysisRuleCount: z.number().int().min(0).optional(),
  reassignedAnalysisRuleCount: z.number().int().min(0).optional(),
});

export const addRecipientSchema = z.object({
  name: z.string().trim().min(1).max(80),
  phone: phoneSchema,
});

export const updateRecipientSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    phone: phoneSchema.optional(),
    enabled: z.boolean().optional(),
    confirmedAnalysisAlertRuleCount: z.number().int().min(1).optional(),
    replacementRecipientId: z.string().min(1).optional(),
  })
  .refine(
    (value) => value.name !== undefined || value.phone !== undefined || value.enabled !== undefined,
    "At least one recipient field is required",
  );

export const deleteRecipientSchema = z.object({
  confirmedAnalysisAlertRuleCount: z.number().int().min(1).optional(),
  replacementRecipientId: z.string().min(1).optional(),
});

export const recipientImpactWarningSchema = z.object({
  message: z.string(),
  confirmationRequired: z.literal(true),
  affectedAnalysisRuleCount: z.number().int().positive(),
});

export const updateAlertSettingsSchema = z.object({
  insightAlertsEnabled: z.boolean().optional(),
  tradingviewAlertsEnabled: z.boolean().optional(),
  cooldownSeconds: z.number().int().min(0).max(86400).optional(),
});

export const sendAlertSchema = z
  .object({
    recipientIds: z.array(z.string()).max(100).optional(),
    message: z.string().trim().min(1).max(1600).optional(),
    insight: z
      .object({
        headline: z.string().trim().min(1).max(300),
        detail: z.string().trim().max(1200).optional(),
      })
      .optional(),
    dedupeKey: z.string().trim().max(200).optional(),
  })
  .refine((value) => Boolean(value.message || value.insight), "Message or insight is required");

export const tradingViewEventSchema = z.object({
  secret: z.string().optional(),
  symbol: z.string().trim().min(2).max(30),
  event: z.string().trim().min(1).max(80),
  side: z.enum(["long", "short", "buy", "sell"]).optional(),
  entry: z.coerce.number().finite().positive(),
  stop: z.coerce.number().finite().positive(),
  target: z.coerce.number().finite().positive(),
  timeframe: z.string().trim().min(1).max(20),
  strategy: z.string().trim().max(120).optional(),
  exchange: z.string().trim().max(80).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  timestamp: z.string().datetime().optional(),
});

export const smsDiagnosticCheckSchema = z.object({
  id: z.string(),
  state: z.enum(["ok", "warn", "fail"]),
  title: z.string(),
  detail: z.string(),
  action: z.string().nullable(),
});

export const smsDiagnosticsSchema = z.object({
  checkedAt: z.string(),
  checks: z.array(smsDiagnosticCheckSchema),
  push: z.object({
    configured: z.boolean(),
    sent: z.number().int().min(0),
    failed: z.number().int().min(0),
    lastError: z.string().nullable(),
    lastSentAt: z.string().nullable(),
  }),
});

export const testPushSchema = z.object({
  message: z.string().trim().min(1).max(500).optional(),
});

export type SmsDiagnosticCheck = z.infer<typeof smsDiagnosticCheckSchema>;
export type SmsDiagnostics = z.infer<typeof smsDiagnosticsSchema>;
export type AlertStatus = z.infer<typeof alertStatusSchema>;
export type AlertRecipient = z.infer<typeof alertRecipientSchema>;
export type AlertSettings = z.infer<typeof alertSettingsSchema>;
export type DeliveryRecord = z.infer<typeof deliveryRecordSchema>;
export type RollingMetric = z.infer<typeof rollingMetricSchema>;
export type TradingViewEvent = z.infer<typeof tradingViewEventSchema>;
