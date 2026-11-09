import { z } from "zod";
import { env } from "../config/env.js";
import { audit } from "./audit.service.js";

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

async function call<S extends z.ZodType>(
  path: string,
  payload: unknown,
  schema: S,
  ctx: { userId?: string; requestId?: string },
): Promise<z.infer<S>> {
  const started = Date.now();
  const res = await fetch(new URL(path, env.PYTHON_SERVICE_URL), {
    method: "POST",
    headers: { "content-type": "application/json", "x-service-token": env.PYTHON_SERVICE_TOKEN },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10 * 60_000), // document generation can take a few minutes
  });
  const text = await res.text();
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
  if (!res.ok) throw new Error(`Python service ${path} returned ${res.status}: ${text.slice(0, 500)}`);
  return schema.parse(JSON.parse(text));
}

export const aiClient = {
  /** Step 1 of evaluation. Sends only the posting and company details. */
  fraud: (job: JobForAi, ctx: { userId?: string; requestId?: string }) => call("/evaluate/fraud", job, FraudResult, ctx),

  /** Step 2 of evaluation. Sends only the posting; no fraud findings. */
  match: (
    body: { title: string; company: string; description: string; location?: string | null; preferred_category?: string | null },
    ctx: { userId?: string; requestId?: string },
  ) => call("/evaluate/match", body, MatchResult, ctx),

  documents: (
    body: { job_id: string; job: JobForAi; applicant: ApplicantForAi; resume_category: string; keywords: string[] },
    ctx: { userId?: string; requestId?: string },
  ) => call("/documents", body, DocumentsResult, ctx),

  answers: (
    body: { job: JobForAi; applicant: ApplicantForAi; questions: FormQuestion[] },
    ctx: { userId?: string; requestId?: string },
  ) => call("/answers", body, AnswersResult, ctx),
};
