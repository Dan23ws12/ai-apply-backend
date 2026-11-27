import { Router } from "express";
import path from "node:path";
import { existsSync } from "node:fs";
import { prisma } from "../lib/prisma.js";
import { HttpError, notFound } from "../lib/errors.js";
import { body, params, query, validate } from "../middleware/validate.js";
import { EvaluateQuery, FileParams, IdParams, JobListQuery, UpdateFilesBody, UpdateJobBody } from "../schemas/index.js";
import { SKIP_MATCH_FRAUD_RATING, evaluateJob, generateDocuments } from "../services/pipeline.service.js";
import { autofillStatus, startAutofill } from "../autofill/autofill.service.js";
import { isBlacklisted } from "../services/blacklist.service.js";
import { jobInclude, ownApplication, setStatus, toJobView } from "../services/jobs.service.js";
import type { Prisma } from "../generated/prisma/client.js";

/**
 * "Jobs" in the API are applications (one user's application to one posting), returned
 * flattened with their posting's details. The id is the application id.
 */
export const jobsRouter = Router();

/** The user's job as the flat API view, or 404. */
async function ownJob(userId: string, id: string) {
  return toJobView(await ownApplication(userId, id));
}

jobsRouter.get("/", validate({ query: JobListQuery }), async (req, res) => {
  const q = query(req, JobListQuery);
  const where: Prisma.ApplicationWhereInput = {
    userId: req.user!.id,
    applicationStatus: q.status,
    searchWebsite: q.website,
    matchRating: q.minMatch !== undefined ? { gte: q.minMatch } : undefined,
    posting: {
      locationType: q.locationType,
      fraudRating: q.maxFraud !== undefined ? { lte: q.maxFraud } : undefined,
    },
  };
  const [rows, total] = await Promise.all([
    prisma.application.findMany({
      where,
      include: { ...jobInclude, posting: { ...jobInclude.posting, omit: { description: true } } },
      orderBy: [{ matchRating: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
    }),
    prisma.application.count({ where }),
  ]);
  const items = rows.map((r) => toJobView({ ...r, posting: { ...r.posting, description: null } }, { withDescription: false }));
  res.json({ items, total, page: q.page, pageSize: q.pageSize });
});

jobsRouter.get("/:id", validate({ params: IdParams }), async (req, res) => {
  res.json({ item: toJobView(await ownApplication(req.user!.id, params(req, IdParams).id)) });
});

/** Status history of the job, oldest first (e.g. FOUND -> SAVED -> APPLIED). */
jobsRouter.get("/:id/history", validate({ params: IdParams }), async (req, res) => {
  const app = await ownApplication(req.user!.id, params(req, IdParams).id);
  const items = await prisma.applicationStatusEvent.findMany({
    where: { applicationId: app.id },
    orderBy: { createdAt: "asc" },
    select: { fromStatus: true, toStatus: true, message: true, createdAt: true },
  });
  res.json({ items });
});

/** Change the status by hand, e.g. SAVED, or APPLIED after you submit. */
jobsRouter.patch("/:id", validate({ params: IdParams, body: UpdateJobBody }), async (req, res) => {
  const { id } = params(req, IdParams);
  const app = await ownApplication(req.user!.id, id);
  const data = body(req, UpdateJobBody);
  const status = data.applicationStatus ?? app.applicationStatus;
  await setStatus(id, status, {
    statusMessage: data.statusMessage,
    applicationDate: data.applicationStatus === "APPLIED" ? new Date() : undefined,
  });
  res.json({ item: toJobView(await ownApplication(req.user!.id, id)) });
});

/**
 * Re-runs the evaluation: fraud likelihood rating first, then the job match rating, unless
 * the fraud rating is above the job's limit (its search's maxFraudRating, 40 for jobs no
 * saved search found) or 80 or more. The two ratings are worked out independently.
 * Cached ratings are reused; add ?refresh=true to ask the AI again (costs an AI call).
 */
jobsRouter.post("/:id/evaluate", validate({ params: IdParams, query: EvaluateQuery }), async (req, res) => {
  const { id } = params(req, IdParams);
  const { refresh } = query(req, EvaluateQuery);
  await ownJob(req.user!.id, id);
  const { fraud, match, matchSkippedReason, cached } = await evaluateJob(id, { userId: req.user!.id, requestId: req.requestId }, { refresh });
  res.json({
    cached,
    fraud: { rating: fraud.fraud_rating, reasoning: fraud.reasoning, redFlags: fraud.red_flags, checks: fraud.checks },
    match: match
      ? { rating: match.match_rating, reasoning: match.reasoning, resumeCategory: match.resume_category, keywords: match.keywords }
      : { rating: null, skipped: true, reason: matchSkippedReason },
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
    where: { applicationId: job.id },
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
