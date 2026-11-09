import path from "node:path";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import ExcelJS from "exceljs";
import { env } from "../config/env.js";
import { HttpError } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";

/**
 * Writes the jobs a user applied to on one date into the Excel application log.
 *
 * Counted as "applied": status APPLIED (the user submitted the form) AND a resume was made
 * for the job. Saved, skipped, failed (ERROR) and unfinished (INCOMPLETE / FORM_FILLED)
 * applications are left out.
 *
 * Left out of the sheet on purpose: fraud rating, user ID and the job's posting date.
 * Running it again for the same date updates those rows (matched on Job ID) instead of
 * adding duplicates.
 */

const SHEET_NAME = "Applications";

const COLUMNS: { header: string; key: string; width: number }[] = [
  { header: "Date Applied", key: "dateApplied", width: 14 },
  { header: "Position", key: "position", width: 36 },
  { header: "Company", key: "company", width: 28 },
  { header: "Location", key: "location", width: 24 },
  { header: "Location Type", key: "locationType", width: 14 },
  { header: "Job Type", key: "jobType", width: 13 },
  { header: "Found On", key: "foundOn", width: 13 },
  { header: "Match Rating", key: "matchRating", width: 13 },
  { header: "Application Link", key: "applicationLink", width: 40 },
  { header: "Resume", key: "resume", width: 40 },
  { header: "Cover Letter", key: "coverLetter", width: 40 },
  { header: "Job ID", key: "jobId", width: 38 },
];

const LABELS: Record<string, string> = {
  REMOTE: "Remote", HYBRID: "Hybrid", ON_SITE: "On-site", UNKNOWN: "Unknown",
  FULL_TIME: "Full-time", PART_TIME: "Part-time", CONTRACT: "Contract", INTERNSHIP: "Internship",
  TEMPORARY: "Temporary", OTHER: "Other",
  LINKEDIN: "LinkedIn", GLASSDOOR: "Glassdoor", INDEED: "Indeed", COMPANY_SITE: "Company site",
};

export interface AppliedJobRow {
  jobId: string;
  dateApplied: Date;
  position: string;
  company: string;
  location: string | null;
  locationType: string;
  jobType: string;
  foundOn: string;
  matchRating: number | null;
  applicationLink: string;
  resume: string | null;
  coverLetter: string | null;
}

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

/** Jobs the user applied to on the given date (local time). */
export async function appliedJobsOn(userId: string, date: string): Promise<AppliedJobRow[]> {
  const { start, end } = dayRange(date);
  const jobs = await prisma.application.findMany({
    where: {
      userId,
      applicationStatus: "APPLIED",
      applicationDate: { gte: start, lt: end },
      applicationFiles: { is: { resumeLink: { not: null } } },
    },
    include: {
      posting: { include: { company: { select: { name: true } } } },
      applyOption: { select: { url: true } },
      applicationFiles: true,
    },
    orderBy: { applicationDate: "asc" },
  });
  return jobs.map((j) => ({
    jobId: j.id,
    dateApplied: j.applicationDate!,
    position: j.posting.positionName,
    company: j.posting.company?.name ?? j.posting.companyName,
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

/** A clickable cell: local files open in Word, web links in the browser. */
function link(target: string | null): ExcelJS.CellValue {
  if (!target) return "";
  if (/^https?:\/\//i.test(target)) return { text: target, hyperlink: target };
  const full = path.resolve(target);
  return { text: path.basename(full), hyperlink: pathToFileURL(full).href, tooltip: full };
}

function sheetIsEmpty(ws: ExcelJS.Worksheet): boolean {
  let empty = true;
  ws.eachRow({ includeEmpty: false }, (row) => {
    row.eachCell({ includeEmpty: false }, (cell) => {
      if (cell.value !== null && cell.value !== "") empty = false;
    });
  });
  return empty;
}

async function openWorkbook(file: string): Promise<{ wb: ExcelJS.Workbook; ws: ExcelJS.Worksheet }> {
  const wb = new ExcelJS.Workbook();
  if (existsSync(file)) await wb.xlsx.readFile(file);

  let ws = wb.getWorksheet(SHEET_NAME);
  if (!ws) {
    // Reuse a blank default sheet (the workbook starts with an empty "Sheet1").
    const blank = wb.worksheets.find(sheetIsEmpty);
    ws = blank ?? wb.addWorksheet(SHEET_NAME);
    ws.name = SHEET_NAME;
  }

  ws.columns = COLUMNS.map((c) => ({ key: c.key, width: c.width }));
  const header = ws.getRow(1);
  COLUMNS.forEach((c, i) => {
    const cell = header.getCell(i + 1);
    cell.value = c.header;
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E78" } };
    cell.alignment = { vertical: "middle" };
  });
  header.commit();
  ws.views = [{ state: "frozen", ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: COLUMNS.length } };
  return { wb, ws };
}

export async function writeApplicationLog(rows: AppliedJobRow[]) {
  const file = logFilePath();
  if (!existsSync(path.dirname(file))) throw new HttpError(500, `Folder for the application log does not exist: ${path.dirname(file)}`);

  const { wb, ws } = await openWorkbook(file);
  const jobIdCol = COLUMNS.findIndex((c) => c.key === "jobId") + 1;

  // Existing rows by Job ID, so a re-run updates instead of duplicating.
  const existing = new Map<string, number>();
  ws.eachRow({ includeEmpty: false }, (row, n) => {
    if (n === 1) return;
    const id = row.getCell(jobIdCol).value;
    if (typeof id === "string" && id) existing.set(id, n);
  });

  let added = 0;
  let updated = 0;
  for (const r of rows) {
    const values: Record<string, ExcelJS.CellValue> = {
      dateApplied: r.dateApplied,
      position: r.position,
      company: r.company,
      location: r.location ?? "",
      locationType: r.locationType,
      jobType: r.jobType,
      foundOn: r.foundOn,
      matchRating: r.matchRating ?? "",
      applicationLink: link(r.applicationLink),
      resume: link(r.resume),
      coverLetter: link(r.coverLetter),
      jobId: r.jobId,
    };
    const rowNumber = existing.get(r.jobId);
    const row = rowNumber ? ws.getRow(rowNumber) : ws.getRow(ws.actualRowCount + 1);
    COLUMNS.forEach((c, i) => {
      const cell = row.getCell(i + 1);
      cell.value = values[c.key] ?? "";
      if (c.key === "dateApplied") cell.numFmt = "yyyy-mm-dd";
      if (["applicationLink", "resume", "coverLetter"].includes(c.key) && cell.value) {
        cell.font = { color: { argb: "FF0563C1" }, underline: true };
      }
    });
    row.commit();
    if (rowNumber) updated++;
    else {
      added++;
      existing.set(r.jobId, row.number);
    }
  }

  try {
    await wb.xlsx.writeFile(file);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EBUSY" || code === "EPERM" || code === "EACCES") {
      throw new HttpError(423, "The application log is open in another program (probably Excel). Close it and try again.");
    }
    throw err;
  }
  return { file, added, updated };
}
