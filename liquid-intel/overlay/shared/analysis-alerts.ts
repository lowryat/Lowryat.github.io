import { z } from "zod";
import { historyMetricSchema, historyRangeSchema } from "./history";
import { intelligenceMetricKeySchema } from "./intelligence";

export const analysisAlertSourceSchema = z.enum(["history", "intelligence", "coinglass"]);
export const coinGlassAlertMetricSchema = z.enum([
  "fundingRate",
  "openInterestUsd",
  "longLiquidationsUsd",
  "shortLiquidationsUsd",
  "longShortAccountRatio",
  "fundingZScore",
  "liquidationZScore",
  "priceOiDivergence",
]);
export const analysisAlertMetricSchema = z.union([
  historyMetricSchema,
  intelligenceMetricKeySchema,
  coinGlassAlertMetricSchema,
]);
export const analysisAlertConditionSchema = z.enum([
  "above",
  "below",
  "crossAbove",
  "crossBelow",
]);
export const analysisAlertDeliveryChannelSchema = z.enum(["in_app", "sms"]);
/** "delivered" / "undelivered" are carrier receipts applied after Twilio accepts ("sent") a message. */
export const analysisAlertDeliveryStatusSchema = z.enum(["pending", "sent", "failed", "rate_limited", "delivered", "undelivered"]);
export const analysisAlertDeliveryFailureCategorySchema = z.enum([
  "provider_unavailable",
  "sender_rejected",
  "recipient_rejected",
]);
export const analysisAlertDeliveryDiagnosticSchema = z.object({
  category: analysisAlertDeliveryFailureCategorySchema,
  message: z.string(),
  recoveryAction: z.string(),
});
export const analysisAlertDestinationStateSchema = z.enum([
  "not_applicable",
  "configured",
  "disabled",
  "deleted",
  "unconfigured",
]);
export const analysisAlertResultSchema = z.enum([
  "not_evaluated",
  "not_triggered",
  "triggered",
  "cooldown",
  "skipped_missing",
  "skipped_stale",
  "skipped_unchanged",
  "skipped_source_unavailable",
  "evaluation_error",
]);

const symbolSchema = z.string().trim().toUpperCase().regex(/^[A-Z0-9._:-]{2,30}$/, "Use a valid asset symbol");

const analysisAlertInputSchema = z.object({
  source: analysisAlertSourceSchema.default("history"),
  symbol: symbolSchema,
  metric: analysisAlertMetricSchema,
  window: historyRangeSchema,
  condition: analysisAlertConditionSchema,
  threshold: z.coerce.number().finite(),
  cooldownSeconds: z.coerce.number().int().min(60).max(604800).default(300),
  enabled: z.boolean().default(true),
  deliveryChannel: analysisAlertDeliveryChannelSchema.default("in_app"),
  deliveryRecipientId: z.string().uuid().optional(),
});

function validateMetricSource(value: { source?: AnalysisAlertSource; metric?: AnalysisAlertMetric }, context: z.RefinementCtx) {
  if (!value.source || !value.metric) return;
  const coinGlassMetric = coinGlassAlertMetricSchema.safeParse(value.metric).success;
  const intelligenceMetric = intelligenceMetricKeySchema.safeParse(value.metric).success;
  if (value.source === "coinglass" && !coinGlassMetric) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["metric"], message: "Select a CoinGlass metric for a CoinGlass rule." });
  }
  if (value.source === "intelligence" && !intelligenceMetric) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["metric"], message: "Select an intelligence metric for an intelligence rule." });
  }
  if (value.source === "history" && (coinGlassMetric || intelligenceMetric)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["metric"], message: "Select a stored-history metric for a history rule." });
  }
}

export const createAnalysisAlertSchema = analysisAlertInputSchema
  .superRefine(validateMetricSource)
  .superRefine((value, context) => {
    if (value.deliveryChannel === "sms" && !value.deliveryRecipientId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["deliveryRecipientId"],
        message: "Select an enabled SMS recipient.",
      });
    } else if (value.deliveryChannel === "in_app" && value.deliveryRecipientId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["deliveryRecipientId"],
        message: "In-app rules cannot store an SMS recipient.",
      });
    }
  });

export const updateAnalysisAlertSchema = analysisAlertInputSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, "At least one field is required")
  .superRefine(validateMetricSource);

export const previewAnalysisAlertSchema = analysisAlertInputSchema.extend({
  currentValue: z.coerce.number().finite(),
  previousValue: z.coerce.number().finite().optional(),
}).superRefine(validateMetricSource);

export const analysisAlertRuleSchema = analysisAlertInputSchema.extend({
  id: z.string().uuid(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastValue: z.number().nullable(),
  lastObservedAt: z.string().nullable(),
  lastEvaluatedAt: z.string().nullable(),
  lastTriggeredAt: z.string().nullable(),
  lastResult: analysisAlertResultSchema.nullable(),
  lastResultDetail: z.string().nullable(),
  deliveryPhoneDisplay: z.string().nullable(),
  deliveryDestinationState: analysisAlertDestinationStateSchema,
});

export const analysisAlertDeliveryAttemptSchema = z.object({
  id: z.string().uuid(),
  attemptNumber: z.number().int().positive(),
  status: analysisAlertDeliveryStatusSchema,
  error: z.string().nullable(),
  diagnostic: analysisAlertDeliveryDiagnosticSchema.nullable(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
});

export const analysisAlertEventSchema = z.object({
  id: z.string().uuid(),
  ruleId: z.string().uuid(),
  source: analysisAlertSourceSchema,
  symbol: z.string(),
  metric: analysisAlertMetricSchema,
  window: historyRangeSchema,
  condition: analysisAlertConditionSchema,
  threshold: z.number(),
  value: z.number(),
  previousValue: z.number().nullable(),
  channel: analysisAlertDeliveryChannelSchema,
  deliveryStatus: analysisAlertDeliveryStatusSchema,
  deliveryError: z.string().nullable(),
  deliveryDiagnostic: analysisAlertDeliveryDiagnosticSchema.nullable(),
  deliveryAttempts: z.array(analysisAlertDeliveryAttemptSchema),
  retryable: z.boolean().default(false),
  createdAt: z.string(),
});

export const analysisAlertsStatusSchema = z.object({
  rules: z.array(analysisAlertRuleSchema),
  events: z.array(analysisAlertEventSchema),
});

export type AnalysisAlertSource = z.infer<typeof analysisAlertSourceSchema>;
export type AnalysisAlertMetric = z.infer<typeof analysisAlertMetricSchema>;
export type AnalysisAlertCondition = z.infer<typeof analysisAlertConditionSchema>;
export type AnalysisAlertDeliveryChannel = z.infer<typeof analysisAlertDeliveryChannelSchema>;
export type AnalysisAlertDeliveryStatus = z.infer<typeof analysisAlertDeliveryStatusSchema>;
export type AnalysisAlertDeliveryFailureCategory = z.infer<typeof analysisAlertDeliveryFailureCategorySchema>;
export type AnalysisAlertDeliveryDiagnostic = z.infer<typeof analysisAlertDeliveryDiagnosticSchema>;
export type AnalysisAlertDestinationState = z.infer<typeof analysisAlertDestinationStateSchema>;
export type AnalysisAlertResult = z.infer<typeof analysisAlertResultSchema>;
export type AnalysisAlertRule = z.infer<typeof analysisAlertRuleSchema>;
export type AnalysisAlertDeliveryAttempt = z.infer<typeof analysisAlertDeliveryAttemptSchema>;
export type AnalysisAlertEvent = z.infer<typeof analysisAlertEventSchema>;
export type AnalysisAlertsStatus = z.infer<typeof analysisAlertsStatusSchema>;
