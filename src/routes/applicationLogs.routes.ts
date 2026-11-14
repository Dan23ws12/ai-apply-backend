import { Router } from "express";
import { body, query, validate } from "../middleware/validate.js";
import { ApplicationLogBody, ApplicationLogQuery } from "../schemas/index.js";
import { exportApplicationLog, logFilePath, previewApplicationLog } from "../services/applicationLog.service.js";
import { ledgerFilePath } from "../services/applicationLedger.service.js";
import { audit } from "../services/audit.service.js";

export const applicationLogsRouter = Router();

/**
 * Preview: the ledger rows the next export would write (nothing is written to Excel).
 * No date = every row not yet in Excel; a date = every row applied that day.
 */
applicationLogsRouter.get("/", validate({ query: ApplicationLogQuery }), async (req, res) => {
  const date = query(req, ApplicationLogQuery).date;
  const { rows, synced } = await previewApplicationLog(req.user!.id, date);
  res.json({ date: date ?? null, file: logFilePath(), ledger: ledgerFilePath(), synced, count: rows.length, jobs: rows });
});

/**
 * Writes the SQLite ledger to the Excel application log. No date = every row added or changed
 * since the last export (the usual end-of-day call); a date = rewrite that day's rows.
 * Re-running updates rows (matched on Application Key) instead of duplicating them.
 */
applicationLogsRouter.post("/", validate({ body: ApplicationLogBody }), async (req, res) => {
  const date = body(req, ApplicationLogBody).date;
  const result = await exportApplicationLog(req.user!.id, date);
  audit({
    type: "HTTP_RESPONSE",
    userId: req.user!.id,
    requestId: req.requestId,
    message: `application log ${date ?? "pending"}: ${result.added} added, ${result.updated} updated, ${result.removed} removed`,
  });
  res.json({ date: date ?? null, ...result });
});
