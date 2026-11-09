import path from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { chromium, type BrowserContext, type Frame, type Page } from "playwright";
import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { hashQuestion } from "../lib/crypto.js";
import { logger } from "../lib/logger.js";
import { HttpError, notFound } from "../lib/errors.js";
import { aiClient, type ApplicantForAi, type FormQuestion } from "../services/ai.client.js";
import { audit } from "../services/audit.service.js";
import { jobForAi, loadApplicant } from "../services/applicant.service.js";
import { getUserCredentials, type SiteLogin } from "../services/credentials.service.js";
import { markError } from "../services/pipeline.service.js";
import { jobInclude, setStatus } from "../services/jobs.service.js";
import { detectFields, type DetectedField } from "./fieldDetector.js";
import { fileKind, profileValue } from "./profileMapper.js";

/**
 * Auto-fill flow
 * ──────────────
 * 1. Opens a VISIBLE Chromium window using a saved browser profile, so you stay
 *    logged in to LinkedIn / Glassdoor between runs (you log in yourself the first time).
 * 2. Goes to the job's application link.
 * 3. Every few seconds, finds new empty fields (also inside iframes and in later
 *    steps of multi-page forms) and fills them from: your profile -> saved answers -> AI.
 * 4. Uploads the tailored resume and cover letter to file inputs.
 * 5. NEVER clicks Next, Submit or any other button. You review and submit.
 * 6. If a "thank you for applying" page appears, the job is marked APPLIED.
 */

interface Ctx {
  userId: string;
  requestId?: string;
}

interface Session {
  jobId: string;
  page: Page;
  startedAt: Date;
  filledFields: number;
  stopped: boolean;
}

const contexts = new Map<string, BrowserContext>(); // one browser per user profile
const sessions = new Map<string, Session>(); // key = jobId

const SUBMITTED_TEXT =
  /(application (has been |was )?(submitted|received|sent))|(thank(s| you) for (applying|your application))|(we('ve| have) received your application)|(your application was sent)/i;
const POLL_MS = 3000;

async function getContext(userId: string): Promise<BrowserContext> {
  const existing = contexts.get(userId);
  if (existing) return existing;

  const dir = path.resolve(env.BROWSER_PROFILE_DIR, userId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const context = await chromium.launchPersistentContext(dir, {
    headless: false, // the user must see the form to review and submit it
    viewport: null,
    args: ["--start-maximized"],
  });
  context.on("close", () => contexts.delete(userId));
  contexts.set(userId, context);
  return context;
}

export async function startAutofill(jobId: string, ctx: Ctx) {
  if (sessions.get(jobId) && !sessions.get(jobId)!.stopped) {
    throw new HttpError(409, "Auto-fill is already running for this job");
  }
  const job = await prisma.application.findFirst({ where: { id: jobId, userId: ctx.userId }, include: jobInclude });
  if (!job) throw notFound("Job");
  const applicationLink = job.applyOption.url;

  const applicant = await loadApplicant(ctx.userId);
  const credentials = await getUserCredentials(ctx.userId);
  const files = {
    resume: localFile(job.applicationFiles?.resumeLink),
    coverLetter: localFile(job.applicationFiles?.coverLetterLink),
  };

  const context = await getContext(ctx.userId);
  const page = await context.newPage();
  await page.goto(applicationLink, { waitUntil: "domcontentloaded", timeout: 60_000 });

  const session: Session = { jobId, page, startedAt: new Date(), filledFields: 0, stopped: false };
  sessions.set(jobId, session);
  page.on("close", () => (session.stopped = true));

  await setStatus(jobId, "INCOMPLETE", { statusMessage: "Auto-fill in progress" });
  audit({ type: "AUTOFILL", userId: ctx.userId, requestId: ctx.requestId, url: applicationLink, message: `start job ${jobId}` });

  // Run the fill loop in the background; the HTTP request returns right away.
  void fillLoop(session, { job: jobForAi(job), applicant, credentials, files }, ctx);

  return { jobId, url: applicationLink, startedAt: session.startedAt };
}

export function autofillStatus(jobId: string) {
  const s = sessions.get(jobId);
  return s ? { jobId, running: !s.stopped, filledFields: s.filledFields, startedAt: s.startedAt } : null;
}

interface FillInputs {
  job: ReturnType<typeof jobForAi>;
  applicant: ApplicantForAi;
  credentials: Awaited<ReturnType<typeof getUserCredentials>>;
  files: { resume?: string; coverLetter?: string };
}

async function fillLoop(session: Session, inputs: FillInputs, ctx: Ctx) {
  const deadline = Date.now() + env.AUTOFILL_WATCH_MINUTES * 60_000;
  const handled = new Set<string>(); // fields we already filled or tried; never overwrite the user's edits
  let markedFilled = false;

  try {
    while (!session.stopped && Date.now() < deadline) {
      const page = session.page;

      // Submission detection: the USER clicked submit and the site confirmed it.
      // Only checked after we filled something, so a job description can't trigger it.
      const bodyText = markedFilled ? await page.locator("body").innerText({ timeout: 5000 }).catch(() => "") : "";
      if (markedFilled && SUBMITTED_TEXT.test(bodyText)) {
        await setStatus(session.jobId, "APPLIED", { applicationDate: new Date(), statusMessage: "Submitted by user" });
        audit({ type: "AUTOFILL", userId: ctx.userId, url: page.url(), message: `job ${session.jobId} submitted by user` });
        break;
      }

      await fillLoginIfNeeded(page, inputs.credentials);

      for (const frame of page.frames()) {
        const filled = await fillFrame(frame, inputs, handled, ctx).catch((err) => {
          logger.debug({ err: (err as Error).message }, "Frame fill skipped");
          return 0;
        });
        session.filledFields += filled;
      }

      if (session.filledFields > 0 && !markedFilled) {
        markedFilled = true;
        await setStatus(session.jobId, "FORM_FILLED", { statusMessage: "Form filled. Review it and submit it yourself." });
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  } catch (err) {
    if (!session.stopped) await markError(session.jobId, err, ctx);
  } finally {
    session.stopped = true;
    audit({ type: "AUTOFILL", userId: ctx.userId, message: `stop job ${session.jobId}, filled ${session.filledFields} fields` });
  }
}

async function fillFrame(frame: Frame, inputs: FillInputs, handled: Set<string>, ctx: Ctx): Promise<number> {
  const fields = (await detectFields(frame)).filter((f) => !handled.has(f.id) && f.kind !== "password");
  if (!fields.length) return 0;

  const fileFieldCount = fields.filter((f) => f.kind === "file").length;
  const pending: DetectedField[] = [];
  let filled = 0;

  for (const field of fields) {
    handled.add(field.id);
    if (field.hasValue) continue;

    if (field.kind === "file") {
      const kind = fileKind(field, fileFieldCount);
      const file = kind ? inputs.files[kind] : undefined;
      if (file) {
        await frame.locator(`[data-jaf-id="${field.id}"]`).setInputFiles(file);
        filled++;
      }
      continue;
    }

    const value = profileValue(field, inputs.applicant);
    if (value !== undefined) {
      if (await setValue(frame, field, value)) filled++;
    } else if (field.label) {
      pending.push(field);
    }
  }

  if (pending.length) filled += await fillWithAnswers(frame, pending, inputs, ctx);
  return filled;
}

/** Saved answers first, then one AI call for everything still unanswered. */
async function fillWithAnswers(frame: Frame, fields: DetectedField[], inputs: FillInputs, ctx: Ctx) {
  const hashes = new Map(fields.map((f) => [f.id, hashQuestion(f.label + "|" + f.options.join("|"))]));
  const saved = await prisma.applicationAnswer.findMany({
    where: { userId: ctx.userId, questionHash: { in: [...hashes.values()] } },
  });
  const savedByHash = new Map(saved.map((a) => [a.questionHash, a.answer]));

  let filled = 0;
  const unanswered: DetectedField[] = [];
  for (const f of fields) {
    const answer = savedByHash.get(hashes.get(f.id)!);
    if (answer !== undefined) {
      if (await setValue(frame, f, answer)) filled++;
    } else {
      unanswered.push(f);
    }
  }
  if (!unanswered.length) return filled;

  const questions: FormQuestion[] = unanswered.map((f) => ({
    id: f.id,
    label: f.label,
    type: (["select", "radio", "checkbox", "textarea", "number", "date"].includes(f.kind) ? f.kind : "text") as FormQuestion["type"],
    options: f.options.length ? f.options : undefined,
    required: f.required,
  }));
  const { answers } = await aiClient.answers({ job: inputs.job, applicant: inputs.applicant, questions }, ctx);

  for (const a of answers) {
    const field = unanswered.find((f) => f.id === a.id);
    if (!field || !a.answer) continue;
    // Only remember confident answers; unsure ones are left for the user to check.
    if (a.confident) {
      await prisma.applicationAnswer.upsert({
        where: { userId_questionHash: { userId: ctx.userId, questionHash: hashes.get(field.id)! } },
        create: { userId: ctx.userId, questionHash: hashes.get(field.id)!, question: field.label, answer: a.answer, source: "AI" },
        update: {},
      });
    }
    if (await setValue(frame, field, a.answer)) filled++;
  }
  return filled;
}

/** Sets a field's value. Checks radios/checkboxes but never clicks buttons or links. */
async function setValue(frame: Frame, field: DetectedField, value: string): Promise<boolean> {
  try {
    if (field.kind === "radio") {
      const idx = bestOption(field.options, value);
      if (idx < 0) return false;
      await frame.locator(`[data-jaf-id="${field.id}-${idx}"]`).check({ force: true, timeout: 3000 });
      return true;
    }
    const el = frame.locator(`[data-jaf-id="${field.id}"]`);
    if (field.kind === "select") {
      const idx = bestOption(field.options, value);
      if (idx < 0) return false;
      await el.selectOption({ label: field.options[idx]! }, { timeout: 3000 });
      return true;
    }
    if (field.kind === "checkbox") {
      if (/^(yes|true|agree|i agree|checked)$/i.test(value.trim())) await el.check({ timeout: 3000 });
      return true;
    }
    await el.fill(value, { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

function bestOption(options: string[], answer: string): number {
  const a = answer.trim().toLowerCase();
  let idx = options.findIndex((o) => o.trim().toLowerCase() === a);
  if (idx < 0) idx = options.findIndex((o) => o.toLowerCase().includes(a) || a.includes(o.toLowerCase()));
  return idx;
}

/**
 * Pre-fills the email/password boxes on a LinkedIn or Glassdoor sign-in page with
 * the saved credentials. You still click "Sign in" yourself (and handle any 2FA).
 */
async function fillLoginIfNeeded(page: Page, creds: FillInputs["credentials"]) {
  const host = new URL(page.url()).hostname;
  let login: SiteLogin | undefined;
  if (host.endsWith("linkedin.com")) login = creds.linkedin;
  else if (host.includes("glassdoor.")) login = creds.glassdoor;
  if (!login) return;

  const password = page.locator('input[type="password"]:visible').first();
  if (!(await password.count()) || (await password.inputValue().catch(() => ""))) return;
  const email = page.locator('input[type="email"]:visible, input[name="session_key"]:visible, input[autocomplete="username"]:visible').first();
  if (await email.count()) await email.fill(login.email).catch(() => undefined);
  await password.fill(login.password).catch(() => undefined);
}

function localFile(link: string | null | undefined): string | undefined {
  if (!link || /^https?:\/\//.test(link)) return undefined;
  const full = path.resolve(link);
  return existsSync(full) ? full : undefined;
}

export async function closeAllBrowsers() {
  await Promise.all([...contexts.values()].map((c) => c.close().catch(() => undefined)));
}
