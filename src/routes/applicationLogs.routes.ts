import { Router } from "express";
import { body, query, validate } from "../middleware/validate.js";
import { ApplicationLogBody, ApplicationLogQuery } from "../schemas/index.js";
import {
  appliedJobsOn,
  logFilePath,
  todayLocal,
  writeApplicationLog,
} from "../services/applicationLog.service.js";
import { audit } from "../services/audit.service.js";

export const applicationLogsRouter = Router();

/** Preview: the jobs that would be written for a date (nothing is written). */
applicationLogsRouter.get("/", validate({ query: ApplicationLogQuery }), async (req, res) => {
  const date = query(req, ApplicationLogQuery).date ?? todayLocal();
  const jobs = await appliedJobsOn(req.user!.id, date);
  res.json({ date, file: logFilePath(), count: jobs.length, jobs });
});

/**
 * Writes the jobs you applied to on a date (default: today) to the Excel application log.
 * Re-running for the same date updates those rows instead of duplicating them.
 */
applicationLogsRouter.post("/", validate({ body: ApplicationLogBody }), async (req, res) => {
  const date = body(req, ApplicationLogBody).date ?? todayLocal();
  const jobs = await appliedJobsOn(req.user!.id, date);
  const result = await writeApplicationLog(jobs);
  audit({
    type: "HTTP_RESPONSE",
    userId: req.user!.id,
    requestId: req.requestId,
    message: `application log ${date}: ${result.added} added, ${result.updated} updated`,
  });
  res.json({ date, ...result, count: jobs.length });
});
