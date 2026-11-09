import { Router } from "express";
import path from "node:path";
import { existsSync } from "node:fs";
import { prisma } from "../lib/prisma.js";
import { HttpError, notFound } from "../lib/errors.js";
import { body, params, query, validate } from "../middleware/validate.js";
import { FileParams, IdParams, JobListQuery, UpdateFilesBody, UpdateJobBody } from "../schemas/index.js";
import { SKIP_MATCH_FRAUD_RATING, evaluateJob, generateDocuments } from "../services/pipeline.service.js";
import { autofillStatus, startAutofill } from "../autofill/autofill.service.js";
import { isBlacklisted } from "../services/blacklist.service.js";

export const jobsRouter = Router();

async function ownJob(userId: string, id: string) {
  const job = await prisma.job.findFirst({
    where: { id, userId },
    include: { company: true, applicationFiles: true },
  });
  if (!job) throw notFound("Job");
  return job;
}

jobsRouter.get("/", validate({ query: JobListQuery }), async (req, res) => {
  const q = query(req, JobListQuery);
  const where = {
    userId: req.user!.id,
    applicationStatus: q.status,
    searchWebsite: q.website,
    locationType: q.locationType,
    matchRating: q.minMatch !== undefined ? { gte: q.minMatch } : undefined,
    fraudRating: q.maxFraud !== undefined ? { lte: q.maxFraud } : undefined,
  };
  const [items, total] = await Promise.all([
    prisma.job.findMany({
      where,
      include: { company: { select: { id: true, name: true } }, applicationFiles: true },
      orderBy: [{ matchRating: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
      omit: { description: true },
    }),
    prisma.job.count({ where }),
  ]);
  res.json({ items, total, page: q.page, pageSize: q.pageSize });
});

jobsRouter.get("/:id", validate({ params: IdParams }), async (req, res) => {
  res.json({ item: await ownJob(req.user!.id, params(req, IdParams).id) });
});

/** Change the status by hand, e.g. SAVED, or APPLIED after you submit. */
jobsRouter.patch("/:id", validate({ params: IdParams, body: UpdateJobBody }), async (req, res) => {
  const { id } = params(req, IdParams);
  await ownJob(req.user!.id, id);
  const data = body(req, UpdateJobBody);
  const item = await prisma.job.update({
    where: { id },
    data: {
      ...data,
      applicationDate: data.applicationStatus === "APPLIED" ? new Date() : undefined,
    },
  });
  res.json({ item });
});

/**
 * Re-runs the evaluation: fraud likelihood rating first, then (unless fraud >= 80)
 * the job match rating. The two ratings are worked out independently.
 */
jobsRouter.post("/:id/evaluate", validate({ params: IdParams }), async (req, res) => {
  const { id } = params(req, IdParams);
  await ownJob(req.user!.id, id);
  const { fraud, match } = await evaluateJob(id, { userId: req.user!.id, requestId: req.requestId });
  res.json({
    fraud: { rating: fraud.fraud_rating, reasoning: fraud.reasoning, redFlags: fraud.red_flags, checks: fraud.checks },
    match: match
      ? { rating: match.match_rating, reasoning: match.reasoning, resumeCategory: match.resume_category, keywords: match.keywords }
      : { rating: null, skipped: true, reason: "Fraud rating is 80 or more" },
  });
});

jobsRouter.post("/:id/documents", validate({ params: IdParams }), async (req, res) => {
  const files = await generateDocuments(params(req, IdParams).id, { userId: req.user!.id, requestId: req.requestId });
  res.status(201).json({ files });
});

// ── Application files ──
jobsRouter.get("/:id/files", validate({ params: IdParams }), async (req, res) => {
  const job = await ownJob(req.user!.id, params(req, IdParams).id);
  res.json({ files: job.applicationFiles });
});

/** Point the job at a different resume / cover letter. null resets it to the AI version. */
jobsRouter.patch("/:id/files", validate({ params: IdParams, body: UpdateFilesBody }), async (req, res) => {
  const job = await ownJob(req.user!.id, params(req, IdParams).id);
  if (!job.applicationFiles) throw new HttpError(409, "Generate documents for this job first");
  const data = body(req, UpdateFilesBody);
  for (const link of [data.resumeLink, data.coverLetterLink]) {
    if (link && !/^https?:\/\//.test(link) && !existsSync(path.resolve(link))) {
      throw new HttpError(400, `File not found: ${link}`);
    }
  }
  const files = await prisma.applicationFile.update({
    where: { jobId: job.id },
    data: {
      resumeLink: data.resumeLink === null ? job.applicationFiles.aiResumeLink : data.resumeLink,
      coverLetterLink: data.coverLetterLink === null ? job.applicationFiles.aiCoverLetterLink : data.coverLetterLink,
    },
  });
  res.json({ files });
});

/** Download the resume or cover letter currently set for the job. */
jobsRouter.get("/:id/files/:kind", validate({ params: FileParams }), async (req, res) => {
  const { id, kind } = params(req, FileParams);
  const job = await ownJob(req.user!.id, id);
  const link = kind === "resume" ? job.applicationFiles?.resumeLink : job.applicationFiles?.coverLetterLink;
  if (!link) throw notFound("File");
  if (/^https?:\/\//.test(link)) return res.redirect(link);
  res.download(path.resolve(link));
});

/**
 * Opens the application page in a visible browser and fills the form.
 * The app NEVER clicks submit: you review the answers and submit yourself.
 */
jobsRouter.post("/:id/autofill", validate({ params: IdParams }), async (req, res) => {
  const job = await ownJob(req.user!.id, params(req, IdParams).id);
  if (await isBlacklisted(req.user!.id, job.companyId)) throw new HttpError(409, "Company is blacklisted");
  if (job.fraudRating != null && job.fraudRating >= SKIP_MATCH_FRAUD_RATING) {
    throw new HttpError(409, `This posting is very likely a scam (fraud rating ${job.fraudRating}/100)`);
  }
  if (!job.applicationFiles?.resumeLink) throw new HttpError(409, "Generate documents for this job first");
  const session = await startAutofill(job.id, { userId: req.user!.id, requestId: req.requestId });
  res.status(202).json({
    message: "Browser opened. Check every answer, then click Submit yourself.",
    session,
  });
});

jobsRouter.get("/:id/autofill", validate({ params: IdParams }), async (req, res) => {
  const job = await ownJob(req.user!.id, params(req, IdParams).id);
  res.json({ status: job.applicationStatus, session: autofillStatus(job.id) });
});
