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
  CREDENTIALS_ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, "base64").length === 32, {
      message: "CREDENTIALS_ENCRYPTION_KEY must be 32 bytes encoded as base64",
    }),

  JSEARCH_API_KEY: z.string().optional().default(""),
  JSEARCH_API_HOST: z.string().default("jsearch.p.rapidapi.com"),
  SERPAPI_API_KEY: z.string().optional().default(""),

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
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment variables:\n" + z.prettifyError(parsed.error));
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
