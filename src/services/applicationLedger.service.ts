import path from "node:path";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { env } from "../config/env.js";
import { normalizeCompanyName } from "./search/normalize.js";

/**
 * Application ledger: a small SQLite file that gets one row the moment an application is
 * marked APPLIED. It is the source of truth for the Excel application log, which is only
 * rebuilt from it on demand (POST /api/application-logs), usually once at the end of the day.
 *
 * Why a separate file next to Postgres:
 *  - Each write is one small atomic SQLite transaction, so a crash loses at most the
 *    application in progress, and Excel being open never blocks logging.
 *  - The ledger keeps a frozen record of what was sent (links, resume, cover letter) even
 *    if the Postgres database is reset.
 *
 * Every row has an application key (see applicationKey()): the same user applying to the same
 * position at the same company and location always gets the same key, even when the job was
 * found twice (another search API, a re-post). The key de-duplicates the log and lets the
 * search pipeline skip jobs you already applied to.
 */

export interface LedgerInput {
  userId: string;
  /** Postgres applications.id (the API calls it the job id). */
  jobId: string;
  dateApplied: Date;
  position: string;
  company: string;
  companyWebsite: string | null;
  location: string | null;
  locationType: string;
  jobType: string;
  foundOn: string;
  matchRating: number | null;
  applicationLink: string;
  resume: string | null;
  coverLetter: string | null;
}

export interface LedgerRow extends LedgerInput {
  applicationKey: string;
  timesApplied: number;
  withdrawn: boolean;
  recordedAt: Date;
  updatedAt: Date;
  exportedAt: Date | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS applications (
  application_key  TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL,
  job_id           TEXT NOT NULL UNIQUE,
  date_applied     TEXT NOT NULL,
  position         TEXT NOT NULL,
  company          TEXT NOT NULL,
  company_website  TEXT,
  location         TEXT,
  location_type    TEXT NOT NULL,
  job_type         TEXT NOT NULL,
  found_on         TEXT NOT NULL,
  match_rating     INTEGER,
  application_link TEXT NOT NULL,
  resume           TEXT,
  cover_letter     TEXT,
  times_applied    INTEGER NOT NULL DEFAULT 1,
  withdrawn        INTEGER NOT NULL DEFAULT 0,
  recorded_at      TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  exported_at      TEXT
);
CREATE INDEX IF NOT EXISTS applications_user_date ON applications (user_id, date_applied);
`;

let db: DatabaseSync | null = null;

export function ledgerFilePath(): string {
  return path.resolve(env.APPLICATION_LEDGER_PATH);
}

function open(): DatabaseSync {
  if (db) return db;
  const file = ledgerFilePath();
  mkdirSync(path.dirname(file), { recursive: true });
  const conn = new DatabaseSync(file);
  // Wait instead of failing when another process holds the lock.
  conn.exec("PRAGMA busy_timeout = 5000");
  // Rollback-journal mode (not WAL): one file plus a short-lived journal, which cloud sync
  // folders such as OneDrive handle better than WAL's long-lived -wal / -shm files.
  conn.exec("PRAGMA journal_mode = DELETE");
  conn.exec("PRAGMA synchronous = FULL");
  conn.exec(SCHEMA);
  // Columns added after the first release of the ledger.
  const cols = new Set((conn.prepare("PRAGMA table_info(applications)").all() as { name: string }[]).map((c) => c.name));
  if (!cols.has("company_website")) conn.exec("ALTER TABLE applications ADD COLUMN company_website TEXT");
  db = conn;
  return conn;
}

/** Closes the ledger (tests and shutdown). The next call opens it again. */
export function closeLedger() {
  db?.close();
  db = null;
}

// ─────────────────────────── Application key ───────────────────────────

function normalizeText(s: string | null | undefined): string {
  return (s ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** "Data Analyst (Remote) - Contract" and "Data Analyst" are the same position. */
function normalizePosition(s: string): string {
  const withoutNotes = s.replace(/\([^)]*\)|\[[^\]]*\]/g, " ").replace(/\s[-–|]\s.*$/, "");
  return normalizeText(withoutNotes) || normalizeText(s);
}

/**
 * Stable key for "this user applied to this position at this company in this location",
 * e.g. "JA-3F9A1C07B2D4". Company suffixes (Inc, Ltd), punctuation, accents, letter case
 * and notes in brackets don't change it.
 */
export function applicationKey(userId: string, company: string, position: string, location: string | null): string {
  const parts = [userId, normalizeCompanyName(company) || normalizeText(company), normalizePosition(position), normalizeText(location)];
  const hash = createHash("sha256").update(parts.join("|")).digest("hex");
  return `JA-${hash.slice(0, 12).toUpperCase()}`;
}

// ─────────────────────────────── Writes ───────────────────────────────

/** Runs fn in one SQLite transaction. */
function transaction<T>(fn: (conn: DatabaseSync) => T): T {
  const conn = open();
  conn.exec("BEGIN IMMEDIATE");
  try {
    const result = fn(conn);
    conn.exec("COMMIT");
    return result;
  } catch (err) {
    conn.exec("ROLLBACK");
    throw err;
  }
}

/**
 * Records (or refreshes) one applied job. Safe to call again for the same job: it updates
 * the row instead of adding one. Applying again to a job with the same key (a re-post found
 * under a new job id) updates the row and counts it in timesApplied.
 */
export function recordApplication(input: LedgerInput): { applicationKey: string; created: boolean; repeat: boolean } {
  const key = applicationKey(input.userId, input.company, input.position, input.location);
  const now = new Date().toISOString();
  return transaction((conn) => {
    // The same job id under an older key (only if the key rules change): drop the stale row.
    conn.prepare("DELETE FROM applications WHERE job_id = ? AND application_key <> ?").run(input.jobId, key);
    const existing = conn.prepare("SELECT job_id FROM applications WHERE application_key = ?").get(key) as
      | { job_id: string }
      | undefined;
    const repeat = !!existing && existing.job_id !== input.jobId;
    const values = [
      input.userId,
      input.jobId,
      input.dateApplied.toISOString(),
      input.position,
      input.company,
      input.companyWebsite,
      input.location,
      input.locationType,
      input.jobType,
      input.foundOn,
      input.matchRating,
      input.applicationLink,
      input.resume,
      input.coverLetter,
    ];
    if (!existing) {
      conn
        .prepare(
          `INSERT INTO applications (application_key, user_id, job_id, date_applied, position, company, company_website,
             location, location_type, job_type, found_on, match_rating, application_link, resume, cover_letter,
             recorded_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(key, ...values, now, now);
    } else {
      conn
        .prepare(
          `UPDATE applications SET user_id = ?, job_id = ?, date_applied = ?, position = ?, company = ?, company_website = ?, location = ?,
             location_type = ?, job_type = ?, found_on = ?, match_rating = ?, application_link = ?, resume = ?,
             cover_letter = ?, times_applied = times_applied + ?, withdrawn = 0, updated_at = ?
           WHERE application_key = ?`,
        )
        .run(...values, repeat ? 1 : 0, now, key);
    }
    return { applicationKey: key, created: !existing, repeat };
  });
}

/**
 * The job is no longer APPLIED (its status was corrected by hand). The row is kept but
 * flagged, and the next Excel export removes it from the sheet.
 */
export function withdrawApplication(jobId: string): boolean {
  const res = open()
    .prepare("UPDATE applications SET withdrawn = 1, updated_at = ? WHERE job_id = ? AND withdrawn = 0")
    .run(new Date().toISOString(), jobId);
  return Number(res.changes) > 0;
}

export function markExported(keys: string[], at: Date = new Date()) {
  if (!keys.length) return;
  transaction((conn) => {
    const stmt = conn.prepare("UPDATE applications SET exported_at = ? WHERE application_key = ?");
    for (const k of keys) stmt.run(at.toISOString(), k);
  });
}

// ─────────────────────────────── Reads ────────────────────────────────

interface DbRow {
  application_key: string;
  user_id: string;
  job_id: string;
  date_applied: string;
  position: string;
  company: string;
  company_website: string | null;
  location: string | null;
  location_type: string;
  job_type: string;
  found_on: string;
  match_rating: number | null;
  application_link: string;
  resume: string | null;
  cover_letter: string | null;
  times_applied: number;
  withdrawn: number;
  recorded_at: string;
  updated_at: string;
  exported_at: string | null;
}

function toRow(r: DbRow): LedgerRow {
  return {
    applicationKey: r.application_key,
    userId: r.user_id,
    jobId: r.job_id,
    dateApplied: new Date(r.date_applied),
    position: r.position,
    company: r.company,
    companyWebsite: r.company_website,
    location: r.location,
    locationType: r.location_type,
    jobType: r.job_type,
    foundOn: r.found_on,
    matchRating: r.match_rating,
    applicationLink: r.application_link,
    resume: r.resume,
    coverLetter: r.cover_letter,
    timesApplied: r.times_applied,
    withdrawn: r.withdrawn === 1,
    recordedAt: new Date(r.recorded_at),
    updatedAt: new Date(r.updated_at),
    exportedAt: r.exported_at ? new Date(r.exported_at) : null,
  };
}

/** The ledger row for a key, or null. Withdrawn rows are not "applied". */
export function findApplied(key: string): LedgerRow | null {
  const r = open().prepare("SELECT * FROM applications WHERE application_key = ? AND withdrawn = 0").get(key);
  return r ? toRow(r as unknown as DbRow) : null;
}

/** Rows for jobs applied between start (inclusive) and end (exclusive), withdrawn ones included. */
export function ledgerRowsBetween(userId: string, start: Date, end: Date): LedgerRow[] {
  return (
    open()
      .prepare(
        "SELECT * FROM applications WHERE user_id = ? AND date_applied >= ? AND date_applied < ? ORDER BY date_applied",
      )
      .all(userId, start.toISOString(), end.toISOString()) as unknown as DbRow[]
  ).map(toRow);
}

/** Every row for the user, withdrawn ones included. */
export function allLedgerRows(userId: string): LedgerRow[] {
  return (
    open().prepare("SELECT * FROM applications WHERE user_id = ? ORDER BY date_applied").all(userId) as unknown as DbRow[]
  ).map(toRow);
}

/** Rows added or changed since they were last written to Excel. */
export function pendingLedgerRows(userId: string): LedgerRow[] {
  return (
    open()
      .prepare(
        "SELECT * FROM applications WHERE user_id = ? AND (exported_at IS NULL OR updated_at > exported_at) ORDER BY date_applied",
      )
      .all(userId) as unknown as DbRow[]
  ).map(toRow);
}
