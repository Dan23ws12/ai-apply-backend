import type {
  DatePostedRange,
  JobLocationType,
  JobType,
  SearchWebsite,
} from "../../generated/prisma/enums.js";

const DAY = 24 * 60 * 60 * 1000;

export function datePostedFrom(postedAt: Date | null): DatePostedRange {
  if (!postedAt) return "UNKNOWN";
  const age = Date.now() - postedAt.getTime();
  if (age <= 7 * DAY) return "PAST_WEEK";
  if (age <= 14 * DAY) return "PAST_2_WEEKS";
  if (age <= 30 * DAY) return "PAST_MONTH";
  return "OLDER";
}

/** Converts "3 days ago" / "2 weeks ago" / "30+ days ago" (SerpApi) to a Date. */
export function parseRelativeDate(text: string | undefined | null): Date | null {
  if (!text) return null;
  const m = text.toLowerCase().match(/(\d+)\+?\s*(minute|hour|day|week|month)s?/);
  if (!m) return /just|today/.test(text.toLowerCase()) ? new Date() : null;
  const n = Number(m[1]);
  const unit = { minute: 60_000, hour: 3_600_000, day: DAY, week: 7 * DAY, month: 30 * DAY }[
    m[2] as "minute" | "hour" | "day" | "week" | "month"
  ];
  return new Date(Date.now() - n * unit);
}

export function websiteFrom(publisherOrUrl: string | undefined | null): SearchWebsite {
  const s = (publisherOrUrl ?? "").toLowerCase();
  if (s.includes("linkedin")) return "LINKEDIN";
  if (s.includes("glassdoor")) return "GLASSDOOR";
  if (s.includes("indeed")) return "INDEED";
  if (!s) return "OTHER";
  return "OTHER";
}

const OTHER_JOB_BOARDS = /ziprecruiter|monster|simplyhired|workopolis|jooble|talent\.com|builtin|dice|careerbuilder|eluta|job ?bank|jobillico|wellfound|google|adzuna|snagajob|bebee|jobrapido/i;

/** True when the publisher looks like the employer's own site rather than a job board. */
export function isLikelyCompanySite(publisherOrUrl: string): boolean {
  return websiteFrom(publisherOrUrl) === "OTHER" && !OTHER_JOB_BOARDS.test(publisherOrUrl);
}

export function jobTypeFrom(value: string | undefined | null): JobType {
  const s = (value ?? "").toLowerCase().replace(/[\s_-]/g, "");
  if (s.includes("fulltime")) return "FULL_TIME";
  if (s.includes("parttime")) return "PART_TIME";
  if (s.includes("contract")) return "CONTRACT";
  if (s.includes("intern")) return "INTERNSHIP";
  if (s.includes("temp")) return "TEMPORARY";
  if (!s) return "UNKNOWN";
  return "OTHER";
}

/** Works out remote / hybrid / on-site from the remote flag and the description text. */
export function locationTypeFrom(isRemote: boolean | null | undefined, text: string): JobLocationType {
  const t = text.toLowerCase();
  if (/\bhybrid\b/.test(t)) return "HYBRID";
  if (isRemote || /\b(fully remote|100% remote|remote[- ]first|work from home)\b/.test(t)) return "REMOTE";
  if (/\b(on[- ]site|onsite|in[- ]office|in[- ]person)\b/.test(t)) return "ON_SITE";
  if (isRemote === false) return "ON_SITE";
  return "UNKNOWN";
}

export function normalizeCompanyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(inc|incorporated|ltd|limited|llc|corp|corporation|co|company)\b\.?/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
