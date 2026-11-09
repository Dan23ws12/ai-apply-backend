import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { notFound } from "../lib/errors.js";
import { body, params, query, validate } from "../middleware/validate.js";
import { AuditQuery, IdParams, UpdateAnswerBody } from "../schemas/index.js";

// ── Saved answers to application questions ──
export const answersRouter = Router();

answersRouter.get("/", async (req, res) => {
  const items = await prisma.applicationAnswer.findMany({
    where: { userId: req.user!.id },
    orderBy: { updatedAt: "desc" },
  });
  res.json({ items });
});

/** Correct an AI answer once; it is reused for every later application. */
answersRouter.put("/:id", validate({ params: IdParams, body: UpdateAnswerBody }), async (req, res) => {
  const { count } = await prisma.applicationAnswer.updateMany({
    where: { id: params(req, IdParams).id, userId: req.user!.id },
    data: { answer: body(req, UpdateAnswerBody).answer, source: "USER" },
  });
  if (!count) throw notFound("Answer");
  res.json({ ok: true });
});

answersRouter.delete("/:id", validate({ params: IdParams }), async (req, res) => {
  await prisma.applicationAnswer.deleteMany({ where: { id: params(req, IdParams).id, userId: req.user!.id } });
  res.status(204).end();
});

// ── Audit logs (developer view: only your own rows) ──
export const auditRouter = Router();

auditRouter.get("/", validate({ query: AuditQuery }), async (req, res) => {
  const q = query(req, AuditQuery);
  const items = await prisma.auditLog.findMany({
    where: { userId: req.user!.id, type: q.type, requestId: q.requestId },
    orderBy: { createdAt: "desc" },
    take: q.limit,
  });
  // BigInt ids are not JSON-safe.
  res.json({ items: items.map((i) => ({ ...i, id: i.id.toString() })) });
});
