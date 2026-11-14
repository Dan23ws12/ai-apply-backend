/** Zod schemas for /api/spending. */
import { z } from "zod";

const AiActionEnum = z.enum(["FRAUD_RATING", "MATCH_RATING", "RESUME_TAILORING", "COVER_LETTER", "FORM_ANSWERS", "OTHER"]);
const ApiCategoryEnum = z.enum(["AI", "JOB_SEARCH", "OTHER"]);
const BillingPeriodEnum = z.enum([
  "PER_REQUEST", "PER_1000_REQUESTS", "PER_MILLION_TOKENS", "PAY_AS_YOU_GO", "DAILY", "WEEKLY", "MONTHLY", "YEARLY", "ONE_TIME",
]);
const SearchProviderEnum = z.enum(["JSEARCH", "SERPAPI"]);

/** "YYYY-MM-DD" checked to be a real calendar date. */
const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the format YYYY-MM-DD")
  .refine((v) => {
    const [y, m, d] = v.split("-").map(Number) as [number, number, number];
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  }, "Not a real date");
const Month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Use the format YYYY-MM");
const Money = z.number().nonnegative().max(1_000_000);
const Rate = z.number().nonnegative().max(100_000);

export const IdParam = z.object({ id: z.uuid() });

// ── token usage ──
export const TokenUsageQuery = z.object({
  from: IsoDate.optional(),
  to: IsoDate.optional(),
  action: AiActionEnum.optional(),
  model: z.string().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(100),
});

export const TokenTotalsQuery = z.object({
  from: IsoDate.optional(),
  to: IsoDate.optional(),
  by: z.enum(["action", "model", "day", "month"]).default("action"),
});

export const SearchUsageQuery = z.object({
  from: IsoDate.optional(),
  to: IsoDate.optional(),
  provider: SearchProviderEnum.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(100),
});

export const SummaryQuery = z.object({ month: Month.optional() });

// ── API services (the APIs you pay for) ──
export const ServiceBody = z.object({
  name: z.string().trim().min(1).max(100),
  category: ApiCategoryEnum,
  searchProvider: SearchProviderEnum.nullable().optional(),
  planName: z.string().trim().max(100).nullable().optional(),
  cost: Money.nullable().optional(),
  currency: z.string().length(3).toUpperCase().default("USD"),
  billingPeriod: BillingPeriodEnum,
  includedUnits: z.number().int().positive().nullable().optional(),
  unitName: z.string().trim().max(50).nullable().optional(),
  websiteUrl: z.url().nullable().optional(),
  isActive: z.boolean().default(true),
  notes: z.string().max(2000).nullable().optional(),
});
export const UpdateServiceBody = ServiceBody.partial();

// ── payments (entered manually) ──
const PaymentFields = z.object({
  serviceId: z.uuid(),
  amount: Money,
  currency: z.string().length(3).toUpperCase().default("USD"),
  billingPeriod: BillingPeriodEnum,
  periodStart: IsoDate.nullable().optional(),
  periodEnd: IsoDate.nullable().optional(),
  /** The day you paid. Leave out (or null) until it is paid. */
  datePaid: IsoDate.nullable().optional(),
  invoiceRef: z.string().trim().max(100).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});
const periodOrder = (v: { periodStart?: string | null; periodEnd?: string | null }) =>
  !v.periodStart || !v.periodEnd || v.periodStart <= v.periodEnd;
export const PaymentBody = PaymentFields.refine(periodOrder, { message: "periodEnd must be on or after periodStart", path: ["periodEnd"] });
export const UpdatePaymentBody = PaymentFields.partial().refine(periodOrder, { message: "periodEnd must be on or after periodStart", path: ["periodEnd"] });
export const PaymentQuery = z.object({
  serviceId: z.uuid().optional(),
  unpaid: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
});

// ── model prices ──
export const PriceBody = z.object({
  provider: z.string().trim().max(50).default("anthropic"),
  model: z.string().trim().min(1).max(100),
  inputPerMTok: Rate,
  outputPerMTok: Rate,
  cacheReadPerMTok: Rate,
  cacheWritePerMTok: Rate,
  webSearchPer1k: Rate.default(10),
  currency: z.string().length(3).toUpperCase().default("USD"),
  effectiveFrom: IsoDate.optional(),
  notes: z.string().max(2000).nullable().optional(),
});
export const UpdatePriceBody = PriceBody.partial();

// ── budgets ──
export const BudgetBody = z.object({
  name: z.string().trim().min(1).max(100),
  serviceId: z.uuid().nullable().optional(),
  category: ApiCategoryEnum.nullable().optional(),
  monthlyLimitUsd: Money,
  alertAtPercent: z.number().int().min(1).max(100).default(80),
  isActive: z.boolean().default(true),
  notes: z.string().max(2000).nullable().optional(),
});
export const UpdateBudgetBody = BudgetBody.partial();
