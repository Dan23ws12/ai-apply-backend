import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { notFound } from "../lib/errors.js";
import { body, params, validate } from "../middleware/validate.js";
import { IdParams, SearchCriteriaBody, UpdateSearchCriteriaBody } from "../schemas/index.js";
import { runSearchCriteria } from "../services/pipeline.service.js";

export const criteriaRouter = Router();

criteriaRouter.get("/", async (req, res) => {
  const items = await prisma.searchCriteria.findMany({
    where: { userId: req.user!.id },
    orderBy: { createdAt: "desc" },
  });
  res.json({ items });
});

criteriaRouter.post("/", validate({ body: SearchCriteriaBody }), async (req, res) => {
  const item = await prisma.searchCriteria.create({
    data: { ...body(req, SearchCriteriaBody), userId: req.user!.id },
  });
  res.status(201).json({ item });
});

criteriaRouter.get("/:id", validate({ params: IdParams }), async (req, res) => {
  const item = await prisma.searchCriteria.findFirst({ where: { id: params(req, IdParams).id, userId: req.user!.id } });
  if (!item) throw notFound("Search criteria");
  res.json({ item });
});

criteriaRouter.patch("/:id", validate({ params: IdParams, body: UpdateSearchCriteriaBody }), async (req, res) => {
  const { id } = params(req, IdParams);
  const { count } = await prisma.searchCriteria.updateMany({
    where: { id, userId: req.user!.id },
    data: body(req, UpdateSearchCriteriaBody),
  });
  if (!count) throw notFound("Search criteria");
  res.json({ item: await prisma.searchCriteria.findUnique({ where: { id } }) });
});

criteriaRouter.delete("/:id", validate({ params: IdParams }), async (req, res) => {
  const { count } = await prisma.searchCriteria.deleteMany({ where: { id: params(req, IdParams).id, userId: req.user!.id } });
  if (!count) throw notFound("Search criteria");
  res.status(204).end();
});

/**
 * Runs the search now. New jobs are saved straight away; scoring and
 * document generation continue in the background (watch GET /api/jobs).
 */
criteriaRouter.post("/:id/run", validate({ params: IdParams }), async (req, res) => {
  const result = await runSearchCriteria(params(req, IdParams).id, { userId: req.user!.id, requestId: req.requestId });
  res.status(202).json(result);
});
