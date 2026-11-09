import { z } from "zod";
import { env } from "../config/env.js";
import { audit } from "./audit.service.js";

/**
 * Client for the Python AI / document service (python-service/).
 * Every response is checked with Zod so a bad reply fails loudly instead of corrupting data.
 */

export const ScoreResult = z.object({
  match_rating: z.number().int().min(0).max(100),
  match_reason: z.string(),
  fraud_rating: z.number().int().min(0).max(100),
  fraud_reason: z.string(),
  resume_category: z.enum(["software_developer", "data_analyst", "business_analyst", "non_it"]),
  keywords: z.array(z.string()),
});
export type ScoreResult = z.infer<typeof ScoreResult>;

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
  score: (body: { job: JobForAi; preferred_category?: string | null }, ctx: { userId?: string; requestId?: string }) =>
    call("/score", body, ScoreResult, ctx),

  documents: (
    body: { job_id: string; job: JobForAi; applicant: ApplicantForAi; resume_category: string; keywords: string[] },
    ctx: { userId?: string; requestId?: string },
  ) => call("/documents", body, DocumentsResult, ctx),

  answers: (
    body: { job: JobForAi; applicant: ApplicantForAi; questions: FormQuestion[] },
    ctx: { userId?: string; requestId?: string },
  ) => call("/answers", body, AnswersResult, ctx),
};
