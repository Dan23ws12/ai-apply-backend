import "dotenv/config";
import { z } from "zod";

/** Validates environment variables once at start-up so a missing key fails fast. */
const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4000),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  CORS_ORIGINS: z.string().default("http://localhost:5173"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  JWT_EXPIRES_IN: z.string().default("7d"),
  /** Link sent for a password reset. {token} is replaced with the reset token. */
  PASSWORD_RESET_URL: z.string().default("http://localhost:5173/reset-password?token={token}"),
  PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().min(5).max(1440).default(60),
  /** Uploaded resumes / cover letters. Relative paths start at the backend folder. */
  UPLOAD_DIR: z.string().default("./storage/uploads"),
  UPLOAD_MAX_MB: z.coerce.number().positive().max(50).default(10),
  /** How long a document preview / download link works. */
  FILE_LINK_TTL_MINUTES: z.coerce.number().int().min(1).max(1440).default(30),
  CREDENTIALS_ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, "base64").length === 32, {
      message: "CREDENTIALS_ENCRYPTION_KEY must be 32 bytes encoded as base64",
    }),

  JSEARCH_API_KEY: z.string().optional().default(""),
  JSEARCH_API_HOST: z.string().default("jsearch.p.rapidapi.com"),
  SERPAPI_API_KEY: z.string().optional().default(""),

  // ── Caching (cost control) ──
  /** Hours a cached search stays usable. After that the search starts again from page 1. */
  SEARCH_CACHE_TTL_HOURS: z.coerce.number().positive().default(24),
  /**
   * The search API is only called for a cached search when fewer than this many jobs
   * matching the search are still open (in the cache and not yet saved, or saved with
   * status FOUND, DOCUMENTS_READY, FORM_FILLED, SAVED or INCOMPLETE).
   */
  SEARCH_REFRESH_THRESHOLD: z.coerce.number().int().min(0).default(20),
  /** Most pages kept per cached search (top-ups stop here until the entry expires). */
  SEARCH_CACHE_MAX_PAGES: z.coerce.number().int().min(1).max(20).default(10),
  /** Days a fraud rating is reused. Company / domain checks can change, so keep this short-ish. */
  FRAUD_CACHE_TTL_DAYS: z.coerce.number().positive().default(14),
  /** Days a match rating is reused. Editing a resume or skill file invalidates it straight away. */
  MATCH_CACHE_TTL_DAYS: z.coerce.number().positive().default(30),
  /** Change this to throw away every cached rating (e.g. after changing the AI model or prompts). */
  EVALUATION_CACHE_VERSION: z.string().default("1"),
  /** Folder that holds resumes/, shared-references/ and .agents/skills/ (fingerprinted for the match cache). */
  REFERENCES_ROOT: z.string().default("."),

  PYTHON_SERVICE_URL: z.url().default("http://127.0.0.1:8000"),
  PYTHON_SERVICE_TOKEN: z.string().min(8),

  BROWSER_PROFILE_DIR: z.string().default("./storage/browser-profiles"),
  PREFER_DIRECT_APPLY: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  AUTOFILL_WATCH_MINUTES: z.coerce.number().int().positive().default(20),

  /** Excel workbook that POST /api/application-logs writes applied jobs to. Relative paths start at the backend folder. */
  APPLICATION_LOG_PATH: z.string().default("../docs/AI Job Application Logs.xlsx"),
  /** SQLite file that records each application the moment it is marked APPLIED (source of truth for the Excel log). */
  APPLICATION_LEDGER_PATH: z.string().default("./storage/application-ledger.sqlite"),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment variables:\n" + z.prettifyError(parsed.error));
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
