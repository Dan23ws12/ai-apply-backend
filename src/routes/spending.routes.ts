import { Router } from "express";
import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { HttpError, notFound } from "../lib/errors.js";
import { body, params, query, validate } from "../middleware/validate.js";
import {
  BudgetBody,
  IdParam,
  PaymentBody,
  PaymentQuery,
  PriceBody,
  SearchUsageQuery,
  ServiceBody,
  SummaryQuery,
  TokenTotalsQuery,
  TokenUsageQuery,
  UpdateBudgetBody,
  UpdatePaymentBody,
  UpdatePriceBody,
  UpdateServiceBody,
} from "../schemas/spending.js";
import {
  clearPriceCache,
  currentMonth,
  spendingSummary,
  tokenUsageOverTime,
  tokenUsageTotals,
} from "../services/spending.service.js";

/**
 * /api/spending: what the app's paid APIs cost.
 * Spending is for the whole installation (one user today), so these routes are not filtered by user.
 */
export const spendingRouter = Router();

/** BigInt ids -> strings and Decimals -> numbers, so responses are plain JSON. */
function plain<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}
const decimalsToNumbers = (row: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v instanceof Prisma.Decimal ? Number(v) : v]));

/** "YYYY-MM-DD" -> local midnight; `to` dates are inclusive. */
const dayStart = (d: string) => {
  const [y, m, day] = d.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, day);
};
const dayAfter = (d: string) => {
  const s = dayStart(d);
  return new Date(s.getFullYear(), s.getMonth(), s.getDate() + 1);
};
/** "YYYY-MM-DD" for a @db.Date column. */
const dateOnly = (d: string | null | undefined) => (d == null ? d : new Date(`${d}T00:00:00Z`));

function usedAtRange(from?: string, to?: string) {
  if (!from && !to) return undefined;
  return { ...(from ? { gte: dayStart(from) } : {}), ...(to ? { lt: dayAfter(to) } : {}) };
}

// ── summary ──

/** Month at a glance: AI tokens and estimated cost, search credits vs quota, payments, budgets. */
spendingRouter.get("/summary", validate({ query: SummaryQuery }), async (req, res) => {
  res.json(plain(await spendingSummary(query(req, SummaryQuery).month ?? currentMonth())));
});

// ── AI token usage ──

/** Every AI call: model, tokens, when, what for, estimated cost. Newest first. */
spendingRouter.get("/token-usage", validate({ query: TokenUsageQuery }), async (req, res) => {
  const q = query(req, TokenUsageQuery);
  const where: Prisma.AiTokenUsageWhereInput = { usedAt: usedAtRange(q.from, q.to), action: q.action, model: q.model };
  const [items, total] = await Promise.all([
    prisma.aiTokenUsage.findMany({
      where,
      orderBy: { usedAt: "desc" },
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
      omit: { details: true },
    }),
    prisma.aiTokenUsage.count({ where }),
  ]);
  res.json(plain({ items: items.map(decimalsToNumbers), total, page: q.page, pageSize: q.pageSize }));
});

/** Totals grouped by action, model, day or month. */
spendingRouter.get("/token-usage/totals", validate({ query: TokenTotalsQuery }), async (req, res) => {
  const q = query(req, TokenTotalsQuery);
  if (q.by === "day" || q.by === "month") {
    const from = q.from ? dayStart(q.from) : new Date(new Date().getFullYear(), 0, 1);
    const to = q.to ? dayAfter(q.to) : new Date(Date.now() + 86_400_000);
    return res.json(plain({ by: q.by, items: await tokenUsageOverTime(from, to, q.by) }));
  }
  res.json(plain({ by: q.by, items: await tokenUsageTotals({ usedAt: usedAtRange(q.from, q.to) }, q.by) }));
});

// ── search API usage ──

spendingRouter.get("/search-usage", validate({ query: SearchUsageQuery }), async (req, res) => {
  const q = query(req, SearchUsageQuery);
  const where: Prisma.SearchApiUsageWhereInput = { usedAt: usedAtRange(q.from, q.to), provider: q.provider };
  const [items, total, totals] = await Promise.all([
    prisma.searchApiUsage.findMany({ where, orderBy: { usedAt: "desc" }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    prisma.searchApiUsage.count({ where }),
    prisma.searchApiUsage.groupBy({ by: ["provider"], where, _sum: { credits: true } }),
  ]);
  res.json(plain({
    items,
    total,
    creditsByProvider: Object.fromEntries(totals.map((t) => [t.provider, t._sum.credits ?? 0])),
    page: q.page,
    pageSize: q.pageSize,
  }));
});

// ── API services ──

spendingRouter.get("/services", async (_req, res) => {
  const items = await prisma.apiService.findMany({ orderBy: { name: "asc" } });
  res.json(plain({ items: items.map(decimalsToNumbers) }));
});

spendingRouter.post("/services", validate({ body: ServiceBody }), async (req, res) => {
  const item = await prisma.apiService.create({ data: body(req, ServiceBody) });
  res.status(201).json(plain({ item: decimalsToNumbers(item) }));
});

spendingRouter.patch("/services/:id", validate({ params: IdParam, body: UpdateServiceBody }), async (req, res) => {
  const item = await prisma.apiService.update({ where: { id: params(req, IdParam).id }, data: body(req, UpdateServiceBody) });
  res.json(plain({ item: decimalsToNumbers(item) }));
});

/** A service with payments can't be deleted (payment history is kept); set isActive=false instead. */
spendingRouter.delete("/services/:id", validate({ params: IdParam }), async (req, res) => {
  const { id } = params(req, IdParam);
  if (await prisma.apiPayment.count({ where: { serviceId: id } })) {
    throw new HttpError(409, "This service has payments. Set isActive to false instead of deleting it.");
  }
  const { count } = await prisma.apiService.deleteMany({ where: { id } });
  if (!count) throw notFound("API service");
  res.status(204).end();
});

// ── payments ──

spendingRouter.get("/payments", validate({ query: PaymentQuery }), async (req, res) => {
  const q = query(req, PaymentQuery);
  const items = await prisma.apiPayment.findMany({
    where: { serviceId: q.serviceId, datePaid: q.unpaid === true ? null : q.unpaid === false ? { not: null } : undefined },
    include: { service: { select: { name: true, category: true } } },
    orderBy: [{ periodStart: "desc" }, { createdAt: "desc" }],
  });
  res.json(plain({ items: items.map(decimalsToNumbers) }));
});

spendingRouter.post("/payments", validate({ body: PaymentBody }), async (req, res) => {
  const b = body(req, PaymentBody);
  if (!(await prisma.apiService.findUnique({ where: { id: b.serviceId }, select: { id: true } }))) throw notFound("API service");
  const item = await prisma.apiPayment.create({
    data: { ...b, periodStart: dateOnly(b.periodStart), periodEnd: dateOnly(b.periodEnd), datePaid: dateOnly(b.datePaid) },
  });
  res.status(201).json(plain({ item: decimalsToNumbers(item) }));
});

/** Use this to fill in datePaid once you have paid: { "datePaid": "2026-11-14" }. */
spendingRouter.patch("/payments/:id", validate({ params: IdParam, body: UpdatePaymentBody }), async (req, res) => {
  const b = body(req, UpdatePaymentBody);
  const item = await prisma.apiPayment.update({
    where: { id: params(req, IdParam).id },
    data: {
      ...b,
      periodStart: b.periodStart === undefined ? undefined : dateOnly(b.periodStart),
      periodEnd: b.periodEnd === undefined ? undefined : dateOnly(b.periodEnd),
      datePaid: b.datePaid === undefined ? undefined : dateOnly(b.datePaid),
    },
  });
  res.json(plain({ item: decimalsToNumbers(item) }));
});

spendingRouter.delete("/payments/:id", validate({ params: IdParam }), async (req, res) => {
  const { count } = await prisma.apiPayment.deleteMany({ where: { id: params(req, IdParam).id } });
  if (!count) throw notFound("Payment");
  res.status(204).end();
});

// ── model prices ──

spendingRouter.get("/prices", async (_req, res) => {
  const items = await prisma.aiModelPrice.findMany({ orderBy: [{ model: "asc" }, { effectiveFrom: "desc" }] });
  res.json(plain({ items: items.map(decimalsToNumbers) }));
});

/** Add a row with a later effectiveFrom when prices change; older usage keeps the old price. */
spendingRouter.post("/prices", validate({ body: PriceBody }), async (req, res) => {
  const b = body(req, PriceBody);
  const item = await prisma.aiModelPrice.create({ data: { ...b, effectiveFrom: b.effectiveFrom ? dateOnly(b.effectiveFrom)! : new Date() } });
  clearPriceCache();
  res.status(201).json(plain({ item: decimalsToNumbers(item) }));
});

spendingRouter.patch("/prices/:id", validate({ params: IdParam, body: UpdatePriceBody }), async (req, res) => {
  const b = body(req, UpdatePriceBody);
  const item = await prisma.aiModelPrice.update({
    where: { id: params(req, IdParam).id },
    data: { ...b, effectiveFrom: b.effectiveFrom ? dateOnly(b.effectiveFrom)! : undefined },
  });
  clearPriceCache();
  res.json(plain({ item: decimalsToNumbers(item) }));
});

spendingRouter.delete("/prices/:id", validate({ params: IdParam }), async (req, res) => {
  const { count } = await prisma.aiModelPrice.deleteMany({ where: { id: params(req, IdParam).id } });
  if (!count) throw notFound("Price");
  clearPriceCache();
  res.status(204).end();
});

// ── budgets ──

spendingRouter.get("/budgets", async (_req, res) => {
  const items = await prisma.spendingBudget.findMany({ include: { service: { select: { name: true } } }, orderBy: { name: "asc" } });
  res.json(plain({ items: items.map(decimalsToNumbers) }));
});

spendingRouter.post("/budgets", validate({ body: BudgetBody }), async (req, res) => {
  const item = await prisma.spendingBudget.create({ data: body(req, BudgetBody) });
  res.status(201).json(plain({ item: decimalsToNumbers(item) }));
});

spendingRouter.patch("/budgets/:id", validate({ params: IdParam, body: UpdateBudgetBody }), async (req, res) => {
  const item = await prisma.spendingBudget.update({ where: { id: params(req, IdParam).id }, data: body(req, UpdateBudgetBody) });
  res.json(plain({ item: decimalsToNumbers(item) }));
});

spendingRouter.delete("/budgets/:id", validate({ params: IdParam }), async (req, res) => {
  const { count } = await prisma.spendingBudget.deleteMany({ where: { id: params(req, IdParam).id } });
  if (!count) throw notFound("Budget");
  res.status(204).end();
});
