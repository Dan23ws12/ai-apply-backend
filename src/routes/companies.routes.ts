import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { body, params, query, validate } from "../middleware/validate.js";
import { CompanyBody, CompanyQuery, IdParams, UpdateCompanyBody } from "../schemas/index.js";
import { normalizeCompanyName } from "../services/search/normalize.js";

export const companiesRouter = Router();

companiesRouter.get("/", validate({ query: CompanyQuery }), async (req, res) => {
  const q = query(req, CompanyQuery);
  const items = await prisma.company.findMany({
    where: {
      blacklisted: q.blacklisted,
      name: q.search ? { contains: q.search, mode: "insensitive" } : undefined,
    },
    orderBy: { name: "asc" },
    take: 500,
  });
  res.json({ items });
});

companiesRouter.post("/", validate({ body: CompanyBody }), async (req, res) => {
  const data = body(req, CompanyBody);
  const normalizedName = normalizeCompanyName(data.name) || data.name.toLowerCase();
  const item = await prisma.company.upsert({
    where: { normalizedName },
    create: { ...data, normalizedName },
    update: data,
  });
  res.status(201).json({ item });
});

/** Use { "blacklisted": true } to stop applying to a company. */
companiesRouter.patch("/:id", validate({ params: IdParams, body: UpdateCompanyBody }), async (req, res) => {
  const data = body(req, UpdateCompanyBody);
  const item = await prisma.company.update({
    where: { id: params(req, IdParams).id },
    data: data.name ? { ...data, normalizedName: normalizeCompanyName(data.name) } : data,
  });
  if (data.blacklisted) {
    // Skip this user's open jobs at the company.
    await prisma.job.updateMany({
      where: { companyId: item.id, userId: req.user!.id, applicationStatus: { in: ["FOUND", "DOCUMENTS_READY", "SAVED"] } },
      data: { applicationStatus: "SKIPPED", statusMessage: "Company is blacklisted" },
    });
  }
  res.json({ item });
});
