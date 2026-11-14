import path from "node:path";
import { existsSync } from "node:fs";
import { rename, unlink } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import ExcelJS from "exceljs";
import type { Prisma } from "../generated/prisma/client.js";
import { env } from "../config/env.js";
import { HttpError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
import {
  allLedgerRows,
  ledgerRowsBetween,
  markExported,
  pendingLedgerRows,
  recordApplication,
  withdrawApplication,
  type LedgerInput,
  type LedgerRow,
} from "./applicationLedger.service.js";

/**
 * The application log, in two layers (the "hybrid" approach):
 *
 *  1. As soon as a job is marked APPLIED, onStatusChanged() writes it to the SQLite ledger
 *     (applicationLedger.service.ts). Small, atomic, never blocked by Excel.
 *  2. exportApplicationLog() writes the ledger into the Excel workbook on demand, usually once
 *     at the end of the day. If Excel has the file open it fails with 423 and nothing is lost:
 *     the rows stay pending in the ledger until the next export.
 *
 * The workbook keeps YOUR layout: the sheet whose header row has "Serial Number" (Sheet1),
 * and the Excel table on it (app_logs), if there is one. Columns are found by their header
 * text, so they can be reordered or renamed slightly (case, spaces and punctuation don't matter).
 * An "Application Key" column is added after the last one; re-exports match rows on it, so they
 * update rows instead of duplicating them. Rows without a key (typed in by hand) are kept.
 *
 * Shown in the sheet: ONLY jobs whose status is APPLIED (the user submitted the form) AND that had
 * a resume made. FOUND, SKIPPED, DOCUMENTS_READY, SAVED, FORM_FILLED, INCOMPLETE and ERROR jobs are
 * never logged. A job that leaves APPLIED is withdrawn from the ledger and removed from the sheet,
 * and every export re-checks Postgres in case that was missed. The ledger records every APPLIED job
 * (so duplicates are caught), but rows without a resume are left out of the sheet.
 */

type Field =
  | "serial"
  | "dateApplied"
  | "company"
  | "position"
  | "companyWebsite"
  | "resume"
  | "coverLetter"
  | "foundOn"
  | "status"
  | "locationType"
  | "location"
  | "jobType"
  | "applicationKey";

/** The sheet's columns, in the order used when the workbook has no header row yet. */
const FIELDS: { field: Field; header: string; aliases: string[] }[] = [
  { field: "serial", header: "Serial Number", aliases: ["serial number", "serial", "s n", "no"] },
  { field: "dateApplied", header: "Date Applied", aliases: ["date applied", "date"] },
  { field: "company", header: "Employer", aliases: ["employer", "company"] },
  { field: "position", header: "Job Title", aliases: ["job title", "position", "title"] },
  { field: "companyWebsite", header: "Company Website Link", aliases: ["company website link", "company website", "website"] },
  { field: "resume", header: "Resume Used", aliases: ["resume used", "resume"] },
  { field: "coverLetter", header: "Cover Letter Used", aliases: ["cover letter used", "cover letter"] },
  { field: "foundOn", header: "Job Search Platform", aliases: ["job search platform", "platform", "found on"] },
  { field: "status", header: "Application Status", aliases: ["application status", "status"] },
  { field: "locationType", header: "Work Model / Job Location Type", aliases: ["work model job location type", "work model", "job location type", "location type"] },
  { field: "location", header: "Job Location", aliases: ["job location", "location"] },
  { field: "jobType", header: "Employment Type", aliases: ["employment type", "job type"] },
  { field: "applicationKey", header: "Application Key", aliases: ["application key", "key"] },
];

const LABELS: Record<string, string> = {
  REMOTE: "Remote", HYBRID: "Hybrid", ON_SITE: "On-site", UNKNOWN: "Unknown",
  FULL_TIME: "Full-time", PART_TIME: "Part-time", CONTRACT: "Contract", INTERNSHIP: "Internship",
  TEMPORARY: "Temporary", OTHER: "Other",
  LINKEDIN: "LinkedIn", GLASSDOOR: "Glassdoor", INDEED: "Indeed", COMPANY_SITE: "Company site",
};

/** Local-time start of the day and of the next day for "YYYY-MM-DD". */
function dayRange(date: string): { start: Date; end: Date } {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return { start: new Date(y, m - 1, d), end: new Date(y, m - 1, d + 1) };
}

export function todayLocal(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function logFilePath(): string {
  return path.resolve(env.APPLICATION_LOG_PATH);
}

// ─────────────────────── Layer 1: record each application ───────────────────────

/** APPLIED jobs from Postgres, shaped for the ledger. */
async function appliedJobs(where: Prisma.ApplicationWhereInput): Promise<LedgerInput[]> {
  const jobs = await prisma.application.findMany({
    where: { ...where, applicationStatus: "APPLIED", userId: where.userId ?? { not: null } },
    include: {
      posting: { include: { company: { select: { name: true, websiteUrl: true } } } },
      applyOption: { select: { url: true } },
      applicationFiles: true,
    },
    orderBy: { applicationDate: "asc" },
  });
  return jobs.map((j) => ({
    userId: j.userId!,
    jobId: j.id,
    dateApplied: j.applicationDate ?? j.updatedAt,
    position: j.posting.positionName,
    company: j.posting.company?.name ?? j.posting.companyName,
    companyWebsite: j.posting.company?.websiteUrl ?? null,
    location: j.posting.location,
    locationType: LABELS[j.posting.locationType] ?? j.posting.locationType,
    jobType: LABELS[j.posting.jobType] ?? j.posting.jobType,
    foundOn: LABELS[j.searchWebsite] ?? j.searchWebsite,
    matchRating: j.matchRating,
    applicationLink: j.applyOption.url,
    resume: j.applicationFiles?.resumeLink ?? null,
    coverLetter: j.applicationFiles?.coverLetterLink ?? null,
  }));
}

/**
 * Called right after a job's status changes (see setStatus in jobs.service.ts).
 * APPLIED → the job is written to the ledger; any other status → a ledger row for it, if
 * there is one, is flagged as withdrawn. Never throws: a failure here must not undo the status
 * change, and the end-of-day export syncs from Postgres again anyway.
 */
export async function onStatusChanged(jobId: string, status: string, previous: string | null) {
  try {
    if (status === "APPLIED") {
      const [job] = await appliedJobs({ id: jobId });
      if (!job) return;
      const res = recordApplication(job);
      logger.info({ jobId, ...res }, "Application recorded in the ledger");
    } else if (previous === "APPLIED") {
      if (withdrawApplication(jobId)) logger.info({ jobId, status }, "Application withdrawn from the ledger");
    }
  } catch (err) {
    logger.error({ err, jobId }, "Could not update the application ledger (the next export will catch up)");
  }
}

/**
 * Safety net: copies APPLIED jobs from Postgres for a date range into the ledger when the
 * ledger doesn't have them yet (e.g. a write failed, or they were applied before the ledger
 * existed). Rows already in the ledger are left as they are.
 */
async function syncLedger(userId: string, start: Date, end: Date): Promise<number> {
  const known = new Set(allLedgerRows(userId).map((r) => r.jobId));
  const jobs = await appliedJobs({ userId, applicationDate: { gte: start, lt: end } });
  let added = 0;
  for (const j of jobs) {
    if (known.has(j.jobId)) continue;
    recordApplication(j);
    added++;
  }
  return added;
}

// ─────────────────────── Layer 2: export to Excel ───────────────────────

/**
 * Second safety net: the log must only hold jobs that are still APPLIED. Any ledger row whose job
 * is now another status in Postgres (SAVED, ERROR, INCOMPLETE, ...: changed outside setStatus, or
 * the withdraw write failed) is withdrawn here, which makes the export remove it from the sheet.
 * Jobs deleted from Postgres are kept: the ledger is the record of what was sent.
 */
async function withdrawNoLongerApplied(userId: string): Promise<number> {
  const active = allLedgerRows(userId).filter((r) => !r.withdrawn);
  if (!active.length) return 0;
  const stale = await prisma.application.findMany({
    where: { id: { in: active.map((r) => r.jobId) }, applicationStatus: { not: "APPLIED" } },
    select: { id: true },
  });
  for (const s of stale) withdrawApplication(s.id);
  return stale.length;
}

/** Which ledger rows an export (or preview) covers: one day, or everything not yet in Excel. */
async function rowsToExport(userId: string, date?: string): Promise<{ rows: LedgerRow[]; synced: number }> {
  await withdrawNoLongerApplied(userId);
  if (date) {
    const { start, end } = dayRange(date);
    const synced = await syncLedger(userId, start, end);
    return { rows: ledgerRowsBetween(userId, start, end), synced };
  }
  const { start, end } = dayRange(todayLocal());
  const synced = await syncLedger(userId, start, end);
  return { rows: pendingLedgerRows(userId), synced };
}

export async function previewApplicationLog(userId: string, date?: string) {
  const { rows, synced } = await rowsToExport(userId, date);
  return { synced, rows };
}

/** A clickable cell: local files open in Word, web links in the browser. */
function link(target: string | null): ExcelJS.CellValue {
  if (!target) return "";
  if (/^https?:\/\//i.test(target)) return { text: target, hyperlink: target };
  if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(target)) return { text: target, hyperlink: `https://${target}` };
  const full = path.resolve(target);
  return { text: path.basename(full), hyperlink: pathToFileURL(full).href, tooltip: full };
}

/** The date as Excel shows it: the local calendar day, stored at UTC midnight so it never shifts. */
function excelDate(d: Date): Date {
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
}

const headerKey = (v: unknown) =>
  String(v ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Plain text of a cell value (hyperlinks and rich text included). */
function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object" && !(v instanceof Date)) {
    if ("text" in v && typeof v.text === "string") return v.text;
    if ("richText" in v) return v.richText.map((t) => t.text).join("");
    if ("result" in v) return String(v.result ?? "");
  }
  return String(v);
}

interface Layout {
  ws: ExcelJS.Worksheet;
  table: ExcelJS.Table | null;
  /** Column number of each field found in the header row. */
  cols: Map<Field, number>;
  lastCol: number;
}

/**
 * Finds the log sheet (the one whose header row has "Serial Number"), maps its columns by
 * header text, and adds an "Application Key" column when it is missing. A new or blank
 * workbook gets the default layout.
 */
function findLayout(wb: ExcelJS.Workbook): Layout {
  const isLogSheet = (ws: ExcelJS.Worksheet) => {
    const keys: string[] = [];
    ws.getRow(1).eachCell((c) => keys.push(headerKey(c.value)));
    return keys.includes("serial number");
  };
  let ws = wb.worksheets.find(isLogSheet);
  if (!ws) {
    ws = wb.worksheets.find((w) => w.actualRowCount === 0) ?? wb.addWorksheet("Sheet1");
    FIELDS.forEach((f, i) => (ws!.getRow(1).getCell(i + 1).value = f.header));
    ws.getRow(1).font = { bold: true };
  }

  const cols = new Map<Field, number>();
  let lastCol = 0;
  ws.getRow(1).eachCell((cell, n) => {
    lastCol = Math.max(lastCol, n);
    const key = headerKey(cell.value);
    const f = FIELDS.find((x) => x.aliases.includes(key));
    if (f && !cols.has(f.field)) cols.set(f.field, n);
  });
  // Columns the export adds after your last one when your sheet doesn't have them yet.
  // Once added, you can move them anywhere: they are found by header text.
  for (const [field, width] of [["coverLetter", 22], ["applicationKey", 17]] as const) {
    if (cols.has(field)) continue;
    lastCol++;
    const cell = ws.getRow(1).getCell(lastCol);
    cell.value = FIELDS.find((f) => f.field === field)!.header;
    cell.style = { ...ws.getRow(1).getCell(lastCol - 1).style };
    ws.getColumn(lastCol).width = width;
    cols.set(field, lastCol);
  }

  const tables = (ws as unknown as { tables?: Record<string, ExcelJS.Table> }).tables ?? {};
  const table = Object.values(tables)[0] ?? null;
  return { ws, table, cols, lastCol };
}

const colLetter = (n: number): string => {
  let s = "";
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

/**
 * Grows or shrinks the Excel table to the header + data rows, and adds any new columns to it.
 * ExcelJS reads tables back with the header and totals flags lost, so they are set explicitly
 * (otherwise Excel would treat the header row as data).
 */
function fitTable(layout: Layout, lastRow: number) {
  if (!layout.table) return;
  const t = (layout.table as unknown as { table: Record<string, any> }).table;
  const ref = `A1:${colLetter(layout.lastCol)}${Math.max(lastRow, 2)}`;
  const columns: { name: string; filterButton?: boolean }[] = t.columns ?? [];
  for (let c = columns.length + 1; c <= layout.lastCol; c++) {
    columns.push({ name: cellText(layout.ws.getRow(1).getCell(c).value) || `Column${c}` });
  }
  columns.forEach((c) => (c.filterButton = true));
  Object.assign(t, { tableRef: ref, autoFilterRef: ref, headerRow: true, totalsRow: false, columns });
}

const LOCKED = () =>
  new HttpError(423, "The application log is open in another program (probably Excel). Close it and try again. Nothing was lost: the rows stay in the ledger until the next export.");

/** Excel keeps a "~$<name>" lock file next to a workbook while it is open. */
function openInExcel(file: string): boolean {
  const dir = path.dirname(file);
  const base = path.basename(file);
  return existsSync(path.join(dir, `~$${base}`)) || existsSync(path.join(dir, `~$${base.slice(2)}`));
}

/** One sheet row as data: its cells (value + style) by column number. */
type SheetRow = Map<number, { value: ExcelJS.CellValue; style: Partial<ExcelJS.Style> }>;

/**
 * Writes ledger rows into your sheet: adds new ones, updates changed ones (matched on
 * Application Key), removes withdrawn ones, keeps rows you typed in by hand, renumbers
 * Serial Number and resizes the app_logs table. Saves to a temp file first and renames it over
 * the workbook, so a crash mid-write can't corrupt the log. Rows are marked exported only after
 * the rename succeeds.
 */
export async function exportApplicationLog(userId: string, date?: string) {
  const file = logFilePath();
  if (!existsSync(path.dirname(file))) throw new HttpError(500, `Folder for the application log does not exist: ${path.dirname(file)}`);

  const { rows, synced } = await rowsToExport(userId, date);
  if (openInExcel(file)) throw LOCKED();

  const wb = new ExcelJS.Workbook();
  if (existsSync(file)) await wb.xlsx.readFile(file);
  const layout = findLayout(wb);
  const { ws, cols } = layout;
  const keyCol = cols.get("applicationKey")!;

  // Current data rows, in order. Blank rows (e.g. the table's empty first row) are dropped.
  const lastSheetRow = ws.rowCount;
  const sheetRows: SheetRow[] = [];
  for (let n = 2; n <= lastSheetRow; n++) {
    const row = ws.getRow(n);
    const cells: SheetRow = new Map();
    let blank = true;
    for (let c = 1; c <= layout.lastCol; c++) {
      const cell = row.getCell(c);
      if (cellText(cell.value).trim() !== "") blank = false;
      cells.set(c, { value: cell.value, style: { ...cell.style } });
    }
    if (!blank) sheetRows.push(cells);
  }
  const byKey = new Map<string, SheetRow>();
  for (const r of sheetRows) {
    const key = cellText(r.get(keyCol)?.value ?? null).trim();
    if (key) byKey.set(key, r);
  }

  let added = 0;
  let updated = 0;
  let removed = 0;
  const styleFrom = sheetRows[0];
  for (const r of rows) {
    const existing = byKey.get(r.applicationKey);
    if (r.withdrawn || !r.resume) {
      // Withdrawn (status corrected) or no resume made: must not be in the sheet.
      if (existing) {
        sheetRows.splice(sheetRows.indexOf(existing), 1);
        byKey.delete(r.applicationKey);
        removed++;
      }
      continue;
    }
    const values: Partial<Record<Field, ExcelJS.CellValue>> = {
      dateApplied: excelDate(r.dateApplied),
      company: r.company,
      position: r.position,
      companyWebsite: link(r.companyWebsite),
      resume: link(r.resume),
      coverLetter: link(r.coverLetter),
      foundOn: r.foundOn,
      status: "Applied",
      locationType: r.locationType,
      location: r.location ?? "",
      jobType: r.jobType,
      applicationKey: r.applicationKey,
    };
    const target: SheetRow = existing ?? new Map();
    for (const [field, value] of Object.entries(values) as [Field, ExcelJS.CellValue][]) {
      const c = cols.get(field);
      if (!c) continue; // that column isn't in your sheet
      // Application Status is set once; after that it's yours to change (Interview, Rejected, ...).
      if (field === "status" && cellText(target.get(c)?.value ?? null).trim()) continue;
      const style = target.get(c)?.style ?? { ...(styleFrom?.get(c)?.style ?? {}) };
      if (field === "dateApplied") style.numFmt = "yyyy-mm-dd";
      if ((field === "companyWebsite" || field === "resume" || field === "coverLetter") && value) style.font = { color: { argb: "FF0563C1" }, underline: true };
      target.set(c, { value, style });
    }
    if (existing) updated++;
    else {
      sheetRows.push(target);
      byKey.set(r.applicationKey, target);
      added++;
    }
  }

  // Rewrite the data area top to bottom (so the table stays one block) and renumber.
  const serialCol = cols.get("serial");
  sheetRows.forEach((cells, i) => {
    const row = ws.getRow(i + 2);
    for (let c = 1; c <= layout.lastCol; c++) {
      const cell = row.getCell(c);
      const src = cells.get(c);
      cell.value = c === serialCol ? i + 1 : (src?.value ?? null);
      cell.style = src?.style ?? {};
    }
    row.commit();
  });
  for (let n = sheetRows.length + 2; n <= lastSheetRow; n++) {
    const row = ws.getRow(n);
    for (let c = 1; c <= layout.lastCol; c++) row.getCell(c).value = null;
    row.commit();
  }
  fitTable(layout, sheetRows.length + 1);

  const tmp = path.join(path.dirname(file), `~$${path.basename(file)}.${process.pid}.writing`);
  try {
    await wb.xlsx.writeFile(tmp);
    await rename(tmp, file);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EBUSY" || code === "EPERM" || code === "EACCES") throw LOCKED();
    throw err;
  }

  markExported(rows.map((r) => r.applicationKey));
  return { file, sheet: ws.name, synced, count: rows.length, added, updated, removed, totalRows: sheetRows.length };
}
