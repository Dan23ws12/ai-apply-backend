import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { notFound } from "../lib/errors.js";
import { body, params, query, validate } from "../middleware/validate.js";
import { CompanyBody, CompanyQuery, IdParams, UpdateCompanyBody } from "../schemas/index.js";
import {
  blacklistCompany,
  blacklistedCompanyIds,
  unblacklistCompany,
} from "../services/blacklist.service.js";
import { normalizeCompanyName } from "../services/search/normalize.js";

export const companiesRouter = Router();

/** Companies, each with `blacklisted` showing whether YOU blacklisted it. */
companiesRouter.get("/", validate({ query: CompanyQuery }), async (req, res) => {
  const q = query(req, CompanyQuery);
  const mine = await blacklistedCompanyIds(req.user!.id);
  const companies = await prisma.company.findMany({
    where: {
      name: q.search ? { contains: q.search, mode: "insensitive" } : undefined,
      id: q.blacklisted === true ? { in: [...mine] } : q.blacklisted === false ? { notIn: [...mine] } : undefined,
    },
    orderBy: { name: "asc" },
    take: 500,
  });
  res.json({ items: companies.map((c) => ({ ...c, blacklisted: mine.has(c.id) })) });
});

/** Your blacklist, newest first. */
companiesRouter.get("/blacklisted", async (req, res) => {
  const items = await prisma.blacklisted.findMany({
    where: { userId: req.user!.id },
    include: { company: true },
    orderBy: { createdAt: "desc" },
  });
  res.json({ items });
});

companiesRouter.post("/", validate({ body: CompanyBody }), async (req, res) => {
  const { blacklisted, ...data } = body(req, CompanyBody);
  const normalizedName = normalizeCompanyName(data.name) || data.name.toLowerCase();
  const item = await prisma.company.upsert({
    where: { normalizedName },
    create: { ...data, normalizedName },
    update: data,
  });
  if (blacklisted) await blacklistCompany(req.user!.id, item.id);
  res.status(201).json({ item: { ...item, blacklisted: !!blacklisted } });
});

companiesRouter.patch("/:id", validate({ params: IdParams, body: UpdateCompanyBody }), async (req, res) => {
  const { id } = params(req, IdParams);
  const { blacklisted, ...data } = body(req, UpdateCompanyBody);
  const item = await prisma.company.update({
    where: { id },
    data: data.name ? { ...data, normalizedName: normalizeCompanyName(data.name) } : data,
  });
  if (blacklisted === true) await blacklistCompany(req.user!.id, id);
  if (blacklisted === false) await unblacklistCompany(req.user!.id, id);
  const mine = await blacklistedCompanyIds(req.user!.id);
  res.json({ item: { ...item, blacklisted: mine.has(id) } });
});

/** Add a company to your blacklist. Your open jobs there are marked SKIPPED. */
companiesRouter.put("/:id/blacklist", validate({ params: IdParams }), async (req, res) => {
  const { id } = params(req, IdParams);
  if (!(await prisma.company.findUnique({ where: { id }, select: { id: true } }))) throw notFound("Company");
  res.json({ item: await blacklistCompany(req.user!.id, id) });
});

/** Remove a company from your blacklist. */
companiesRouter.delete("/:id/blacklist", validate({ params: IdParams }), async (req, res) => {
  await unblacklistCompany(req.user!.id, params(req, IdParams).id);
  res.status(204).end();
});

/**
 * Deletes a company. Its rows in "blacklisted" are deleted with it (cascade).
 * Postings (and so jobs) at the company are kept: their companyId becomes null and companyName keeps the name.
 */
companiesRouter.delete("/:id", validate({ params: IdParams }), async (req, res) => {
  const { count } = await prisma.company.deleteMany({ where: { id: params(req, IdParams).id } });
  if (!count) throw notFound("Company");
  res.status(204).end();
});
