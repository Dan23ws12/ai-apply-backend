import { z } from "zod";
import { env } from "../config/env.js";
import { HttpError } from "../lib/errors.js";
import { audit } from "./audit.service.js";
import { recordAiUsage } from "./spending.service.js";

/**
 * Client for the Python AI / document service (python-service/).
 * Every response is checked with Zod so a bad reply fails loudly instead of corrupting data.
 */

/** Fraud likelihood rating: 1-100, higher = more likely a scam. Never uses the resume. */
export const FraudResult = z.object({
  fraud_rating: z.number().int().min(1).max(100),
  reasoning: z.string(),
  red_flags: z.array(z.object({ flag: z.string(), weight: z.enum(["critical", "high", "medium", "low"]) })),
  checks: z.record(z.string(), z.unknown()),
  skip_match: z.boolean(),
});
export type FraudResult = z.infer<typeof FraudResult>;

/** Job match rating: 1-100, higher = better fit. Never uses fraud findings. */
export const MatchResult = z.object({
  match_rating: z.number().int().min(1).max(100),
  resume_category: z.enum(["software_developer", "data_analyst", "business_analyst", "non_it"]),
  no_track_fits: z.boolean(),
  keywords: z.array(z.string()),
  reasoning: z.string(),
  details: z.record(z.string(), z.unknown()),
});
export type MatchResult = z.infer<typeof MatchResult>;

export const DocumentsResult = z.object({
  resume_path: z.string(),
  cover_letter_path: z.string(),
  resume_category: z.string(),
  keywords_used: z.array(z.string()),
});

export const AnswersResult = z.object({
  answers: z.array(z.object({ id: z.string(), answer: z.string(), confident: z.boolean() })),
});

export interface JobForAi {
  title: string;
  company: string;
  company_website?: string | null;
  description: string;
  location?: string | null;
  apply_url?: string | null;
  publisher?: string | null;
}

export interface ApplicantForAi {
  first_name: string;
  last_name: string;
  email: string;
  phone?: string | null;
  city?: string | null;
  region?: string | null;
  country?: string | null;
  linkedin_url?: string | null;
  github_url?: string | null;
  portfolio_url?: string | null;
  work_authorization?: string | null;
  requires_sponsorship?: boolean | null;
  years_of_experience?: number | null;
  desired_salary?: string | null;
  notice_period?: string | null;
  extra_answers?: Record<string, string> | null;
}

export interface FormQuestion {
  id: string;
  label: string;
  type: "text" | "textarea" | "select" | "radio" | "checkbox" | "number" | "date";
  options?: string[];
  required?: boolean;
}

export interface AiCallContext {
  userId?: string;
  requestId?: string;
  /** The application (job) the call is for, saved on its ai_token_usage rows. */
  applicationId?: string;
}

/** "Junior Developer at Northwind": a short label saved with the token usage. */
function subjectOf(payload: unknown): string | null {
  const p = payload as { title?: string; company?: string; job?: { title?: string; company?: string } } | null;
  const job = p?.job ?? p;
  return job?.title ? `${job.title}${job.company ? ` at ${job.company}` : ""}` : null;
}

/** How long one AI service request may take (documents can take a few minutes). */
const AI_TIMEOUT_MS = 10 * 60_000;

/**
 * An AI service failure with a message the user can act on. Extends HttpError, so the API
 * answers with this status and message instead of a generic 500.
 *   503 unreachable  - the service isn't running, or PYTHON_SERVICE_URL is wrong
 *   504 timeout      - it didn't answer within AI_TIMEOUT_MS
 *   502 the rest     - it answered with an error or with something unexpected
 */
export class AiServiceError extends HttpError {
  constructor(status: number, message: string, reason: string, path: string, retryable: boolean) {
    super(status, message, { service: "ai", reason, endpoint: path, retryable });
    this.name = "AiServiceError";
  }
}

/** The network error code under fetch's generic "fetch failed" (ECONNREFUSED, ENOTFOUND, ...). */
function networkCode(err: unknown): string | undefined {
  let e = err as { code?: string; cause?: unknown } | undefined;
  for (let i = 0; e && i < 4; i++) {
    if (typeof e.code === "string") return e.code;
    e = e.cause as typeof e;
  }
  return undefined;
}

function connectionError(err: unknown, path: string): AiServiceError {
  const name = (err as Error)?.name;
  if (name === "TimeoutError" || name === "AbortError") {
    return new AiServiceError(504, `The AI service did not answer within ${AI_TIMEOUT_MS / 60_000} minutes. Try again in a moment.`, "timeout", path, true);
  }
  const code = networkCode(err);
  if (code === "ECONNRESET" || code === "UND_ERR_SOCKET") {
    return new AiServiceError(502, "The connection to the AI service was lost before it finished. Try again.", "connection_lost", path, true);
  }
  return new AiServiceError(
    503,
    `The AI service can't be reached at ${env.PYTHON_SERVICE_URL}${code ? ` (${code})` : ""}. ` +
      "Make sure it is running (cd python-service && uvicorn app.main:app --port 8000) and that PYTHON_SERVICE_URL is correct.",
    "unreachable",
    path,
    true,
  );
}

/** Turns an error reply from the AI service into a clear message. */
function replyError(status: number, detailMessage: string | undefined, path: string): AiServiceError {
  if (status === 401 || status === 403) {
    return new AiServiceError(502, "The AI service rejected the API's service token. PYTHON_SERVICE_TOKEN must be the same in .env and python-service/.env.", "auth", path, false);
  }
  if (status === 404) {
    return new AiServiceError(502, `The AI service has no ${path} endpoint. It may be an older version: update and restart it.`, "not_found", path, false);
  }
  if (status === 422) {
    return new AiServiceError(502, `The AI service could not read the request to ${path}. The API and AI service versions may not match.`, "bad_request", path, false);
  }
  return new AiServiceError(
    502,
    detailMessage ? `The AI service failed: ${detailMessage}` : `The AI service failed with status ${status}. Check its log for details.`,
    "service_error",
    path,
    status >= 500,
  );
}

async function call<S extends z.ZodType>(
  path: string,
  payload: unknown,
  schema: S,
  ctx: AiCallContext,
): Promise<z.infer<S>> {
  const started = Date.now();
  const failed = (err: AiServiceError, statusCode?: number) => {
    audit({
      type: "AI_CALL",
      userId: ctx.userId,
      requestId: ctx.requestId,
      method: "POST",
      url: path,
      statusCode,
      durationMs: Date.now() - started,
      message: err.message,
      metadata: err.details,
    });
    return err;
  };

  let res: Response;
  let text: string;
  try {
    res = await fetch(new URL(path, env.PYTHON_SERVICE_URL), {
      method: "POST",
      headers: { "content-type": "application/json", "x-service-token": env.PYTHON_SERVICE_TOKEN },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(AI_TIMEOUT_MS),
    });
    text = await res.text();
  } catch (err) {
    throw failed(connectionError(err, path));
  }

  // Save the tokens every Claude call used, including calls made before an error.
  let body: { usage?: unknown; detail?: { usage?: unknown; message?: string } } | null = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  const applicationId = ctx.applicationId ?? (payload as { job_id?: string } | null)?.job_id;
  void recordAiUsage(res.ok ? body?.usage : body?.detail?.usage, {
    userId: ctx.userId,
    requestId: ctx.requestId,
    applicationId,
    subject: subjectOf(payload),
  });
  audit({
    type: "AI_CALL",
    userId: ctx.userId,
    requestId: ctx.requestId,
    method: "POST",
    url: path,
    statusCode: res.status,
    durationMs: Date.now() - started,
    message: res.ok ? undefined : text.slice(0, 2000),
  });
  if (!res.ok) {
    // FastAPI puts our message in detail.message, its own errors in detail (string or list).
    const detail = body?.detail as unknown;
    const detailMessage =
      typeof detail === "string" ? detail : typeof (detail as { message?: unknown })?.message === "string" ? (detail as { message: string }).message : undefined;
    throw replyError(res.status, detailMessage?.slice(0, 500), path);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw failed(
      new AiServiceError(502, `The AI service sent an unexpected reply to ${path}. The API and AI service versions may not match.`, "bad_reply", path, false),
      res.status,
    );
  }
  return parsed.data;
}

export const aiClient = {
  /** Step 1 of evaluation. Sends only the posting and company details. */
  fraud: (job: JobForAi, ctx: AiCallContext) => call("/evaluate/fraud", job, FraudResult, ctx),

  /** Step 2 of evaluation. Sends only the posting; no fraud findings. */
  match: (
    body: { title: string; company: string; description: string; location?: string | null; preferred_category?: string | null },
    ctx: AiCallContext,
  ) => call("/evaluate/match", body, MatchResult, ctx),

  documents: (
    body: { job_id: string; job: JobForAi; applicant: ApplicantForAi; resume_category: string; keywords: string[] },
    ctx: AiCallContext,
  ) => call("/documents", body, DocumentsResult, ctx),

  answers: (
    body: { job: JobForAi; applicant: ApplicantForAi; questions: FormQuestion[] },
    ctx: AiCallContext,
  ) => call("/answers", body, AnswersResult, ctx),
};
