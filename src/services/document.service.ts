import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import jwt from "jsonwebtoken";
import JSZip from "jszip";
import { z } from "zod";
import { env } from "../config/env.js";
import { HttpError } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";
import type { ApplicationWithPosting } from "./jobs.service.js";

/**
 * Per-job documents: previews, uploads and short-lived file links.
 *
 * A job's resume / cover letter is the file in application_files.resumeLink /
 * coverLetterLink: the AI-generated file by default, or a file you uploaded.
 * Uploads are stored under UPLOAD_DIR/<userId>/<jobId>/ and replace the link; removing
 * the upload switches back to the AI file.
 *
 * Preview and download links carry a signed token (FILE_LINK_TTL_MINUTES) instead of the
 * login token, so they work in <a>, <iframe> and <img> tags, which can't send headers.
 */

export type DocKind = "resume" | "cover-letter";

/** Matches the frontend's GeneratedDocument. */
export interface DocumentPreview {
  fileName: string;
  previewText: string;
  url?: string;
  source: "AI" | "UPLOADED";
  mimeType?: string;
}

const MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".txt": "text/plain",
  ".md": "text/markdown",
};
export const UPLOAD_EXTENSIONS = [".pdf", ".docx", ".txt"];
const PREVIEW_MAX_CHARS = 20_000;

export const uploadRoot = () => path.resolve(env.UPLOAD_DIR);
const isUpload = (link: string) => path.resolve(link).startsWith(uploadRoot() + path.sep);
export const mimeFor = (file: string) => MIME[path.extname(file).toLowerCase()];

// ── text previews ──

function decodeXml(s: string) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");
}

/** Plain text of a .docx: one line per paragraph, tabs and line breaks kept. */
export async function docxText(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const xml = await zip.file("word/document.xml")?.async("string");
  if (!xml) return "";
  return decodeXml(
    xml
      .replace(/<w:tab\/>/g, "\t")
      .replace(/<w:br[^>]*\/>/g, "\n")
      .replace(/<\/w:p>/g, "\n")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Preview text of a local file. PDFs return "" (the frontend shows them from the url). */
export async function previewText(file: string): Promise<string> {
  const ext = path.extname(file).toLowerCase();
  try {
    if (ext === ".docx") return (await docxText(await readFile(file))).slice(0, PREVIEW_MAX_CHARS);
    if (ext === ".txt" || ext === ".md") return (await readFile(file, "utf8")).slice(0, PREVIEW_MAX_CHARS);
  } catch {
    return "";
  }
  return "";
}

// ── signed file links ──

const FileToken = z.object({ purpose: z.literal("file"), sub: z.string(), job: z.uuid(), kind: z.enum(["resume", "cover-letter"]) });

export function signFileToken(userId: string, jobId: string, kind: DocKind): string {
  return jwt.sign({ purpose: "file", job: jobId, kind }, env.JWT_SECRET, {
    subject: userId,
    expiresIn: env.FILE_LINK_TTL_MINUTES * 60,
  });
}

export function verifyFileToken(token: string) {
  try {
    return FileToken.parse(jwt.verify(token, env.JWT_SECRET));
  } catch {
    throw new HttpError(401, "This file link has expired. Reload the page to get a new one.");
  }
}

// ── previews for a job ──

function linkFor(app: ApplicationWithPosting, kind: DocKind) {
  const f = app.applicationFiles;
  return kind === "resume"
    ? { current: f?.resumeLink ?? null, ai: f?.aiResumeLink ?? null }
    : { current: f?.coverLetterLink ?? null, ai: f?.aiCoverLetterLink ?? null };
}

export async function documentPreview(app: ApplicationWithPosting, kind: DocKind, baseUrl: string): Promise<DocumentPreview | null> {
  const { current, ai } = linkFor(app, kind);
  if (!current) return null;
  const source = current === ai ? "AI" : "UPLOADED";
  if (/^https?:\/\//i.test(current)) {
    return { fileName: path.basename(new URL(current).pathname) || current, previewText: "", url: current, source };
  }
  const full = path.resolve(current);
  return {
    fileName: path.basename(full),
    previewText: existsSync(full) ? await previewText(full) : "",
    url: `${baseUrl}/api/files/${signFileToken(app.userId!, app.id, kind)}`,
    source,
    mimeType: mimeFor(full),
  };
}

export async function documentsFor(app: ApplicationWithPosting, baseUrl: string) {
  const [resume, coverLetter] = await Promise.all([documentPreview(app, "resume", baseUrl), documentPreview(app, "cover-letter", baseUrl)]);
  return { resume, coverLetter };
}

// ── uploads ──

/** Checks the file really is what its extension says (magic bytes), not just its name. */
function checkContent(ext: string, buf: Buffer) {
  const ok =
    ext === ".pdf" ? buf.subarray(0, 5).toString("latin1") === "%PDF-"
    : ext === ".docx" ? buf[0] === 0x50 && buf[1] === 0x4b // zip ("PK")
    : ext === ".txt" ? !buf.subarray(0, 8000).includes(0) // no NUL bytes
    : false;
  if (!ok) throw new HttpError(400, `The file content does not match its ${ext} extension`);
}

export async function saveUpload(app: ApplicationWithPosting, kind: DocKind, file: { originalname: string; buffer: Buffer }) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (!UPLOAD_EXTENSIONS.includes(ext)) throw new HttpError(400, `Upload a ${UPLOAD_EXTENSIONS.join(", ")} file`);
  checkContent(ext, file.buffer);
  if (ext === ".docx") {
    try {
      await docxText(file.buffer);
    } catch {
      throw new HttpError(400, "This .docx file could not be read");
    }
  }

  const dir = path.join(uploadRoot(), app.userId!, app.id);
  await mkdir(dir, { recursive: true });
  const safe = path.basename(file.originalname, ext).replace(/[^\w.\- ]+/g, "_").trim().slice(0, 80) || kind;
  const dest = path.join(dir, `${kind}-${Date.now()}-${safe}${ext}`);
  await writeFile(dest, file.buffer);

  const { current } = linkFor(app, kind);
  const field = kind === "resume" ? "resumeLink" : "coverLetterLink";
  await prisma.applicationFile.upsert({
    where: { applicationId: app.id },
    create: { applicationId: app.id, [field]: dest },
    update: { [field]: dest },
  });
  // The upload it replaces is no longer used.
  if (current && isUpload(current)) await rm(current, { force: true });
  return dest;
}

/** Removes the uploaded file and switches back to the AI-generated one (if any). */
export async function removeUpload(app: ApplicationWithPosting, kind: DocKind) {
  const { current, ai } = linkFor(app, kind);
  if (!current || current === ai || !isUpload(current)) throw new HttpError(404, "No uploaded file to remove");
  const field = kind === "resume" ? "resumeLink" : "coverLetterLink";
  await prisma.applicationFile.update({ where: { applicationId: app.id }, data: { [field]: ai } });
  await rm(current, { force: true });
}
