import path from "node:path";
import { existsSync } from "node:fs";
import { Router } from "express";
import { z } from "zod";
import { env } from "../config/env.js";
import { notFound } from "../lib/errors.js";
import { params, validate } from "../middleware/validate.js";
import { mimeFor, verifyFileToken } from "../services/document.service.js";
import { ownApplication } from "../services/jobs.service.js";

/**
 * GET /api/files/:token: serves a job's resume / cover letter through a signed, short-lived
 * link (from GET /api/jobs/:id/documents). No login header needed, so it works in <a>,
 * <iframe> and <img>. Shown in the browser by default; add ?download=1 to save it.
 */
export const filesRouter = Router();

const TokenParams = z.object({ token: z.string().min(20).max(2000) });

filesRouter.get("/:token", validate({ params: TokenParams }), async (req, res) => {
  const t = verifyFileToken(params(req, TokenParams).token);
  const app = await ownApplication(t.sub, t.job);
  const link = t.kind === "resume" ? app.applicationFiles?.resumeLink : app.applicationFiles?.coverLetterLink;
  if (!link) throw notFound("File");
  if (/^https?:\/\//i.test(link)) return res.redirect(link);
  const full = path.resolve(link);
  if (!existsSync(full)) throw notFound("File");
  const name = path.basename(full);
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  // Let the frontend (another origin, e.g. :5173) show the file in an <iframe> or <img>.
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  res.removeHeader("X-Frame-Options");
  res.setHeader("Content-Security-Policy", `frame-ancestors 'self' ${env.CORS_ORIGINS.split(",").map((o) => o.trim()).join(" ")}`);
  if (req.query.download) return res.download(full, name);
  res.type(mimeFor(full) ?? "application/octet-stream");
  res.setHeader("Content-Disposition", `inline; filename="${name.replace(/"/g, "")}"`);
  res.sendFile(full);
});
