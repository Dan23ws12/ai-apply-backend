import type { ApplicationWithPosting } from "./jobs.service.js";

/**
 * The job shape the frontend uses (ai-job-apply frontend/src/types.ts `Job`), plus the
 * user's status fields. Used by on-demand search and the saved / applied lists.
 */
export interface ClientJob {
  id: string;
  companyName: string;
  positionName: string;
  location: string;
  workModel: string;
  employmentType: string;
  website: string;
  postedAt: string;
  salary?: string;
  description: string;
  applyUrl: string;
  fraudRating: number | null;
  matchRating: number | null;
  applicationStatus: string;
  savedAt: string | null;
  appliedAt: string | null;
}

const BOARDS = ["LINKEDIN", "GLASSDOOR", "INDEED"];
const PERIOD: Record<string, string> = { YEAR: "a year", MONTH: "a month", WEEK: "a week", DAY: "a day", HOUR: "an hour" };

export function formatSalary(min: number | null, max: number | null, currency: string | null, period: string | null): string | undefined {
  if (min == null && max == null) return undefined;
  const symbol = !currency || /USD|CAD|AUD|NZD|\$/.test(currency) ? "$" : `${currency} `;
  const fmt = (n: number) => `${symbol}${Math.round(n).toLocaleString("en-CA")}`;
  const range = min != null && max != null && min !== max ? `${fmt(min)} – ${fmt(max)}` : fmt((min ?? max)!);
  const per = period ? PERIOD[period.toUpperCase()] : undefined;
  return per ? `${range} ${per}` : range;
}

export function toClientJob(a: ApplicationWithPosting): ClientJob {
  const p = a.posting;
  // The board the job was found on; for a company-site listing, the first job board that lists it.
  const website = BOARDS.includes(a.searchWebsite)
    ? a.searchWebsite
    : (p.applyOptions.find((o) => BOARDS.includes(o.website))?.website ?? a.searchWebsite);
  return {
    id: a.id,
    companyName: p.company?.name ?? p.companyName,
    positionName: p.positionName,
    location: p.location ?? "",
    workModel: p.locationType,
    employmentType: p.jobType,
    website,
    postedAt: (p.postedAt ?? a.createdAt).toISOString(),
    salary: formatSalary(p.salaryMin, p.salaryMax, p.salaryCurrency, p.salaryPeriod),
    description: p.description ?? "",
    applyUrl: a.applyOption.url,
    fraudRating: p.fraudRating,
    matchRating: a.matchRating,
    applicationStatus: a.applicationStatus,
    savedAt: a.savedAt?.toISOString() ?? null,
    appliedAt: a.applicationStatus === "APPLIED" ? (a.applicationDate?.toISOString() ?? null) : null,
  };
}
