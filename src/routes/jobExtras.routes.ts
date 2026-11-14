import { Router, type Request } from "express";
import multer from "multer";
import { env } from "../config/env.js";
import { HttpError } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";
import { body, params, validate } from "../middleware/validate.js";
import { AppliedBody, DocKindParams, IdParams, JobSearchBody } from "../schemas/jobs.js";
import { toClientJob } from "../services/clientJob.js";
import { UPLOAD_EXTENSIONS, documentPreview, documentsFor, removeUpload, saveUpload } from "../services/document.service.js";
import { jobInclude, ownApplication, setStatus } from "../services/jobs.service.js";
import { searchOnDemand } from "../services/onDemandSearch.service.js";

/**
 * /api/jobs additions: on-demand search, saved / applied lists, document previews and uploads.
 * Mounted before the main jobs router, so /saved and /applied aren't read as job ids.
 * Ids are job (application) ids, as everywhere in /api/jobs.
 */
export const jobExtrasRouter = Router();

const baseUrl = (req: Request) => `${req.protocol}://${req.get("host")}`;

// ── On-demand search ──

/**
 * Runs a search now and returns the jobs as an array (the frontend's Job shape).
 * Details go in response headers: X-Search-Source (api | cache | cache+api), X-Search-Provider,
 * X-Search-Total-Found, X-Search-New-Jobs and X-Search-Warning.
 */
jobExtrasRouter.post("/search", validate({ body: JobSearchBody }), async (req, res) => {
  const { jobs, meta } = await searchOnDemand(req.user!.id, body(req, JobSearchBody), req.requestId);
  res.set({
    "X-Search-Source": meta.source,
    "X-Search-Provider": meta.provider,
    "X-Search-Total-Found": String(meta.totalFound),
    "X-Search-New-Jobs": String(meta.newJobs),
    ...(meta.warning ? { "X-Search-Warning": meta.warning.replace(/[^\x20-\x7e]/g, " ").slice(0, 300) } : {}),
  });
  res.json(jobs);
});

// ── Saved jobs ──

/** Saved jobs, newest first. Applied jobs leave this list (they're on /applied). */
jobExtrasRouter.get("/saved", async (req, res) => {
  const rows = await prisma.application.findMany({
    where: {
      userId: req.user!.id,
      applicationStatus: { not: "APPLIED" },
      OR: [{ savedAt: { not: null } }, { applicationStatus: "SAVED" }],
    },
    include: jobInclude,
    orderBy: [{ savedAt: { sort: "desc", nulls: "last" } }, { updatedAt: "desc" }],
    take: 500,
  });
  res.json(rows.map(toClientJob));
});

/** Save a job. A job that was only found becomes SAVED; other statuses stay as they are. */
jobExtrasRouter.put("/:id/saved", validate({ params: IdParams }), async (req, res) => {
  const { id } = params(req, IdParams);
  const app = await ownApplication(req.user!.id, id);
  if (app.applicationStatus === "APPLIED") throw new HttpError(409, "You have already applied to this job");
  if (!app.savedAt) await prisma.application.update({ where: { id }, data: { savedAt: new Date() } });
  if (app.applicationStatus === "FOUND") await setStatus(id, "SAVED", { statusMessage: "Saved" });
  res.json(toClientJob(await ownApplication(req.user!.id, id)));
});

/** Un-save a job. A SAVED job goes back to FOUND (or DOCUMENTS_READY if documents exist). */
jobExtrasRouter.delete("/:id/saved", validate({ params: IdParams }), async (req, res) => {
  const { id } = params(req, IdParams);
  const app = await ownApplication(req.user!.id, id);
  await prisma.application.update({ where: { id }, data: { savedAt: null } });
  if (app.applicationStatus === "SAVED") {
    await setStatus(id, app.applicationFiles?.resumeLink ? "DOCUMENTS_READY" : "FOUND", { statusMessage: "Removed from saved jobs" });
  }
  res.status(204).end();
});

// ── Applied jobs ──

/** Jobs you applied to, newest first, each with the resume and cover letter used. */
jobExtrasRouter.get("/applied", async (req, res) => {
  const rows = await prisma.application.findMany({
    where: { userId: req.user!.id, applicationStatus: "APPLIED" },
    include: jobInclude,
    orderBy: [{ applicationDate: { sort: "desc", nulls: "last" } }, { updatedAt: "desc" }],
    take: 500,
  });
  const url = baseUrl(req);
  res.json(
    await Promise.all(
      rows.map(async (r) => ({
        job: toClientJob(r),
        appliedAt: (r.applicationDate ?? r.updatedAt).toISOString(),
        documents: await documentsFor(r, url),
      })),
    ),
  );
});

/** Mark a job as applied (after you submitted it). It leaves the saved list. */
jobExtrasRouter.post("/:id/applied", validate({ params: IdParams, body: AppliedBody }), async (req, res) => {
  const { id } = params(req, IdParams);
  await ownApplication(req.user!.id, id);
  const { appliedAt } = body(req, AppliedBody);
  await setStatus(id, "APPLIED", { applicationDate: appliedAt ? new Date(appliedAt) : new Date(), statusMessage: "Applied" });
  const app = await ownApplication(req.user!.id, id);
  res.json({ job: toClientJob(app), appliedAt: app.applicationDate!.toISOString(), documents: await documentsFor(app, baseUrl(req)) });
});

/** Undo "applied" (e.g. marked by mistake). Goes back to DOCUMENTS_READY, or FOUND without documents. */
jobExtrasRouter.delete("/:id/applied", validate({ params: IdParams }), async (req, res) => {
  const { id } = params(req, IdParams);
  const app = await ownApplication(req.user!.id, id);
  if (app.applicationStatus !== "APPLIED") throw new HttpError(409, "This job is not marked as applied");
  await setStatus(id, app.applicationFiles?.resumeLink ? "DOCUMENTS_READY" : "FOUND", {
    applicationDate: null,
    statusMessage: "Applied status removed",
  });
  res.status(204).end();
});

// ── Documents ──

/**
 * Resume and cover letter for a job: { resume, coverLetter }, each { fileName, previewText,
 * url, source: "AI" | "UPLOADED", mimeType } or null when there is none yet.
 * `url` is a signed link that works without the login header for FILE_LINK_TTL_MINUTES.
 */
jobExtrasRouter.get("/:id/documents", validate({ params: IdParams }), async (req, res) => {
  const app = await ownApplication(req.user!.id, params(req, IdParams).id);
  res.json(await documentsFor(app, baseUrl(req)));
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.UPLOAD_MAX_MB * 1024 * 1024, files: 1 },
});

/** Upload your own resume / cover letter for a job (form field "file": .pdf, .docx or .txt). */
jobExtrasRouter.post(
  "/:id/documents/:kind",
  validate({ params: DocKindParams }),
  (req, res, next) =>
    upload.single("file")(req, res, (err: unknown) => {
      if (err instanceof multer.MulterError) {
        return next(new HttpError(400, err.code === "LIMIT_FILE_SIZE" ? `The file is larger than ${env.UPLOAD_MAX_MB} MB` : err.message));
      }
      next(err);
    }),
  async (req, res) => {
    const { id, kind } = params(req, DocKindParams);
    if (!req.file) throw new HttpError(400, `Send the file in a multipart form field named "file" (${UPLOAD_EXTENSIONS.join(", ")})`);
    await saveUpload(await ownApplication(req.user!.id, id), kind, req.file);
    res.status(201).json(await documentPreview(await ownApplication(req.user!.id, id), kind, baseUrl(req)));
  },
);

/** Remove your uploaded file; the job goes back to the AI-generated document. */
jobExtrasRouter.delete("/:id/documents/:kind", validate({ params: DocKindParams }), async (req, res) => {
  const { id, kind } = params(req, DocKindParams);
  await removeUpload(await ownApplication(req.user!.id, id), kind);
  res.status(204).end();
});
