import { z } from "zod";
import { Prisma } from "../generated/prisma/client.js";
import type { AiAction, SearchProvider } from "../generated/prisma/enums.js";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";

/**
 * Spending tracking.
 *  - recordAiUsage():     one ai_token_usage row per Claude call (from the Python service's "usage" list)
 *  - recordSearchUsage(): one search_api_usage row per JSearch / SerpApi request
 *  - spendingSummary():   monthly totals, payments and budget status for GET /api/spending/summary
 * Recording never throws: tracking must not break the real work.
 */

/** One entry of the "usage" list every Python endpoint returns. */
export const AiUsageEntry = z.object({
  action: z.enum(["FRAUD_RATING", "MATCH_RATING", "RESUME_TAILORING", "COVER_LETTER", "FORM_ANSWERS", "OTHER"]),
  model: z.string(),
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cache_write_tokens: z.number().int().nonnegative().default(0),
  cache_read_tokens: z.number().int().nonnegative().default(0),
  web_search_requests: z.number().int().nonnegative().default(0),
  fallback_used: z.boolean().default(false),
  stop_reason: z.string().nullish(),
  duration_ms: z.number().int().nullish(),
  details: z.record(z.string(), z.unknown()).nullish(),
});
export type AiUsageEntry = z.infer<typeof AiUsageEntry>;

export interface UsageContext {
  userId?: string | null;
  requestId?: string | null;
  applicationId?: string | null;
  subject?: string | null;
}

// ── prices ──

type PriceRow = Awaited<ReturnType<typeof prisma.aiModelPrice.findMany>>[number];
let priceCache: { rows: PriceRow[]; loadedAt: number } | null = null;

async function prices(): Promise<PriceRow[]> {
  if (!priceCache || Date.now() - priceCache.loadedAt > 5 * 60_000) {
    priceCache = { rows: await prisma.aiModelPrice.findMany({ orderBy: { effectiveFrom: "desc" } }), loadedAt: Date.now() };
  }
  return priceCache.rows;
}

/** Call after editing ai_model_prices so new calls use the new prices straight away. */
export function clearPriceCache() {
  priceCache = null;
}

/** Price row for a model at a time. Matches exact ids and dated variants ("claude-x" for "claude-x-2026..."). */
export async function priceFor(model: string, at: Date): Promise<PriceRow | undefined> {
  return (await prices()).find((p) => (model === p.model || model.startsWith(`${p.model}-`)) && p.effectiveFrom <= at);
}

export function estimateCost(e: Pick<AiUsageEntry, "input_tokens" | "output_tokens" | "cache_write_tokens" | "cache_read_tokens" | "web_search_requests">, p: PriceRow): Prisma.Decimal {
  const perM = (tokens: number, rate: Prisma.Decimal) => rate.mul(tokens).div(1_000_000);
  return perM(e.input_tokens, p.inputPerMTok)
    .add(perM(e.output_tokens, p.outputPerMTok))
    .add(perM(e.cache_write_tokens, p.cacheWritePerMTok))
    .add(perM(e.cache_read_tokens, p.cacheReadPerMTok))
    .add(p.webSearchPer1k.mul(e.web_search_requests).div(1000))
    .toDecimalPlaces(6);
}

// ── recording ──

export async function recordAiUsage(entries: unknown, ctx: UsageContext): Promise<void> {
  const parsed = z.array(AiUsageEntry).safeParse(entries ?? []);
  if (!parsed.success) {
    logger.warn({ issues: parsed.error.issues.slice(0, 3) }, "Python service sent usage in an unexpected shape");
    return;
  }
  if (!parsed.data.length) return;
  try {
    const now = new Date();
    const rows = await Promise.all(
      parsed.data.map(async (e) => {
        const price = await priceFor(e.model, now);
        return {
          userId: ctx.userId ?? null,
          applicationId: ctx.applicationId ?? null,
          requestId: ctx.requestId ?? null,
          action: e.action as AiAction,
          model: e.model,
          inputTokens: e.input_tokens,
          outputTokens: e.output_tokens,
          cacheWriteTokens: e.cache_write_tokens,
          cacheReadTokens: e.cache_read_tokens,
          webSearchRequests: e.web_search_requests,
          estimatedCostUsd: price ? estimateCost(e, price) : null,
          priceId: price?.id ?? null,
          fallbackUsed: e.fallback_used,
          stopReason: e.stop_reason ?? null,
          durationMs: e.duration_ms ?? null,
          subject: ctx.subject?.slice(0, 300) ?? null,
          details: (e.details ?? undefined) as Prisma.InputJsonValue | undefined,
          usedAt: now,
        };
      }),
    );
    // An application id that no longer exists must not lose the usage row.
    if (rows.some((r) => r.applicationId)) {
      const ids = [...new Set(rows.map((r) => r.applicationId).filter((x): x is string => !!x))];
      const existing = new Set((await prisma.application.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((a) => a.id));
      for (const r of rows) if (r.applicationId && !existing.has(r.applicationId)) r.applicationId = null;
    }
    await prisma.aiTokenUsage.createMany({ data: rows });
  } catch (err) {
    logger.warn({ err }, "Failed to record AI token usage");
  }
}

export async function recordSearchUsage(e: {
  provider: SearchProvider;
  credits: number;
  resultCount?: number | null;
  statusCode?: number | null;
  userId?: string | null;
  requestId?: string | null;
}): Promise<void> {
  try {
    await prisma.searchApiUsage.create({
      data: {
        provider: e.provider,
        credits: e.credits,
        resultCount: e.resultCount ?? null,
        statusCode: e.statusCode ?? null,
        userId: e.userId ?? null,
        requestId: e.requestId ?? null,
      },
    });
  } catch (err) {
    logger.warn({ err }, "Failed to record search API usage");
  }
}

// ── reports ──

/** First moment of the month and of the next month, local time. month = "YYYY-MM". */
export function monthRange(month: string): { start: Date; end: Date } {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return { start: new Date(y, m - 1, 1), end: new Date(y, m, 1) };
}

export function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

const num = (d: Prisma.Decimal | null | undefined) => (d == null ? 0 : Number(d));

export async function tokenUsageTotals(where: Prisma.AiTokenUsageWhereInput, by: "action" | "model") {
  const rows = await prisma.aiTokenUsage.groupBy({
    by: [by],
    where,
    _count: { _all: true },
    _sum: { inputTokens: true, outputTokens: true, cacheWriteTokens: true, cacheReadTokens: true, webSearchRequests: true, estimatedCostUsd: true },
  });
  return rows
    .map((r) => ({
      [by]: r[by],
      calls: r._count._all,
      inputTokens: r._sum.inputTokens ?? 0,
      outputTokens: r._sum.outputTokens ?? 0,
      cacheWriteTokens: r._sum.cacheWriteTokens ?? 0,
      cacheReadTokens: r._sum.cacheReadTokens ?? 0,
      webSearchRequests: r._sum.webSearchRequests ?? 0,
      estimatedCostUsd: num(r._sum.estimatedCostUsd),
    }))
    .sort((a, b) => b.estimatedCostUsd - a.estimatedCostUsd);
}

/** The server's time zone, e.g. "America/Toronto", so days and months match your calendar. */
const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/** Tokens and estimated cost per day or per month (local time). */
export async function tokenUsageOverTime(from: Date, to: Date, period: "day" | "month") {
  const fmt = period === "day" ? "YYYY-MM-DD" : "YYYY-MM";
  const rows = await prisma.$queryRaw<
    { period: string; calls: bigint; input: bigint; output: bigint; cache_write: bigint; cache_read: bigint; searches: bigint; cost: Prisma.Decimal | null }[]
  >`
    SELECT to_char(date_trunc(${period}, ("usedAt" AT TIME ZONE 'UTC') AT TIME ZONE ${LOCAL_TZ}), ${fmt}) AS period,
           count(*) AS calls,
           sum("inputTokens") AS input, sum("outputTokens") AS output,
           sum("cacheWriteTokens") AS cache_write, sum("cacheReadTokens") AS cache_read,
           sum("webSearchRequests") AS searches, sum("estimatedCostUsd") AS cost
    FROM ai_token_usage
    WHERE "usedAt" >= ${from} AND "usedAt" < ${to}
    GROUP BY 1 ORDER BY 1`;
  return rows.map((r) => ({
    period: r.period,
    calls: Number(r.calls),
    inputTokens: Number(r.input),
    outputTokens: Number(r.output),
    cacheWriteTokens: Number(r.cache_write),
    cacheReadTokens: Number(r.cache_read),
    webSearchRequests: Number(r.searches),
    estimatedCostUsd: num(r.cost),
  }));
}

/** Everything for one month: AI cost, search credits, payments and budget status. */
export async function spendingSummary(month: string) {
  const { start, end } = monthRange(month);
  const inMonth = { usedAt: { gte: start, lt: end } };

  const [byAction, byModel, searchRows, services, payments, budgets] = await Promise.all([
    tokenUsageTotals(inMonth, "action"),
    tokenUsageTotals(inMonth, "model"),
    prisma.searchApiUsage.groupBy({ by: ["provider"], where: inMonth, _sum: { credits: true }, _count: { _all: true } }),
    prisma.apiService.findMany({ orderBy: { name: "asc" } }),
    // Payments whose covered period overlaps the month, or (no period given) that were paid in it.
    prisma.apiPayment.findMany({
      where: {
        OR: [
          { periodStart: { lt: end }, periodEnd: { gte: start } },
          { periodStart: null, datePaid: { gte: start, lt: end } },
        ],
      },
      include: { service: { select: { name: true, category: true } } },
      orderBy: [{ datePaid: "asc" }, { createdAt: "asc" }],
    }),
    prisma.spendingBudget.findMany({ where: { isActive: true }, include: { service: true } }),
  ]);

  const aiEstimated = byAction.reduce((s, r) => s + r.estimatedCostUsd, 0);
  const search = searchRows.map((r) => {
    const service = services.find((s) => s.searchProvider === r.provider);
    const credits = r._sum.credits ?? 0;
    return {
      provider: r.provider,
      service: service?.name ?? null,
      requests: r._count._all,
      creditsUsed: credits,
      includedUnits: service?.includedUnits ?? null,
      percentOfQuota: service?.includedUnits ? Math.round((credits / service.includedUnits) * 100) : null,
    };
  });

  const paidByService = new Map<string, number>();
  for (const p of payments) paidByService.set(p.serviceId, (paidByService.get(p.serviceId) ?? 0) + num(p.amount));
  const paidTotal = [...paidByService.values()].reduce((a, b) => a + b, 0);

  // Spending counted against a budget: payments in the month, plus the AI usage estimate for the
  // Anthropic service when nothing was paid for it this month (pay-as-you-go is billed later).
  const spentFor = (b: (typeof budgets)[number]) => {
    const matches = services.filter((s) =>
      b.serviceId ? s.id === b.serviceId : b.category ? s.category === b.category : true,
    );
    return matches.reduce((sum, s) => {
      const paid = paidByService.get(s.id) ?? 0;
      const usageEstimate = s.category === "AI" && !paidByService.has(s.id) ? aiEstimated : 0;
      return sum + paid + usageEstimate;
    }, 0);
  };

  return {
    month,
    ai: {
      estimatedCostUsd: Number(aiEstimated.toFixed(4)),
      calls: byAction.reduce((s, r) => s + r.calls, 0),
      byAction,
      byModel,
      note: "Estimated from ai_model_prices; your Anthropic invoice is the final amount.",
    },
    search,
    payments: {
      totalPaid: Number(paidTotal.toFixed(2)),
      unpaid: payments.filter((p) => !p.datePaid).length,
      items: payments.map((p) => ({ ...p, amount: num(p.amount) })),
    },
    budgets: budgets.map((b) => {
      const spent = spentFor(b);
      const limit = num(b.monthlyLimitUsd);
      const percent = limit > 0 ? Math.round((spent / limit) * 100) : null;
      return {
        id: b.id,
        name: b.name,
        limitUsd: limit,
        spentUsd: Number(spent.toFixed(2)),
        percentUsed: percent,
        warning: percent != null && percent >= b.alertAtPercent,
        overLimit: percent != null && percent >= 100,
      };
    }),
  };
}
