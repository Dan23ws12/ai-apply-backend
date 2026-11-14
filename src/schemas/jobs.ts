/** Zod schemas for on-demand search, saved / applied lists and per-job documents. */
import { z } from "zod";

const WebsiteEnum = z.enum(["LINKEDIN", "GLASSDOOR", "INDEED"]);
const WorkModelEnum = z.enum(["HYBRID", "REMOTE", "ON_SITE"]);
const EmploymentTypeEnum = z.enum(["FULL_TIME", "PART_TIME", "PERMANENT", "CONTRACT", "TEMPORARY", "INTERNSHIP"]);
const DatePostedEnum = z.enum(["PAST_WEEK", "PAST_2_WEEKS", "PAST_MONTH", "ALL_TIME"]);

/** POST /api/jobs/search. Same shape as the frontend's JobSearchRequest. */
export const JobSearchBody = z.object({
  query: z.string().trim().min(2).max(200).toLowerCase(),
  location: z.string().trim().max(200).default(""),
  /** ISO 3166-1 alpha-2 country code. */
  country: z.string().length(2).toLowerCase().default("ca"),
  /** ALL_TIME = no date limit. */
  datePosted: DatePostedEnum.default("PAST_WEEK"),
  websites: z.array(WebsiteEnum).min(1, "Choose at least one website").default(["LINKEDIN", "GLASSDOOR", "INDEED"]),
  /** Empty = any. */
  workModels: z.array(WorkModelEnum).default([]),
  /** Empty = any. */
  employmentTypes: z.array(EmploymentTypeEnum).default([]),
  /** Oldest post to include (ISO date or date-time). null / missing = no extra limit. */
  postedAfter: z.iso.datetime({ offset: true }).or(z.iso.date()).nullable().optional(),
  includeKeywords: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
  excludeKeywords: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
  /** Most jobs to return. Default: your jobsPerSearch setting. */
  limit: z.number().int().min(1).max(100).optional(),
  /** Rate new results (fraud first, then match) in the background. */
  evaluate: z.boolean().default(true),
});
export type JobSearchBody = z.infer<typeof JobSearchBody>;

export const IdParams = z.object({ id: z.uuid() });

export const AppliedBody = z.object({
  /** When you applied. Default: now. */
  appliedAt: z.iso.datetime({ offset: true }).optional(),
});

export const DocKindParams = z.object({ id: z.uuid(), kind: z.enum(["resume", "cover-letter"]) });
