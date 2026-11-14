import { env } from "../../config/env.js";
import { auditedFetch } from "../audit.service.js";
import { recordSearchUsage } from "../spending.service.js";
import {
  jobTypeFrom,
  locationTypeFrom,
  websiteFrom,
} from "./normalize.js";
import {
  ProviderError,
  type NormalizedJob,
  type PageRequest,
  type ProviderPage,
  type SearchContext,
  type SearchParams,
} from "./types.js";

/** Primary provider: JSearch (OpenWeb Ninja) on RapidAPI. Docs: https://rapidapi.com/letscrape-6bRBa3QguO5/api/jsearch */

interface JSearchJob {
  job_id: string;
  job_title: string;
  employer_name: string;
  employer_website?: string | null;
  job_publisher?: string;
  job_employment_type?: string;
  job_apply_link: string;
  job_apply_is_direct?: boolean;
  apply_options?: { publisher: string; apply_link: string; is_direct: boolean }[];
  job_description?: string;
  job_is_remote?: boolean | null;
  job_posted_at_datetime_utc?: string | null;
  job_location?: string | null;
  job_city?: string | null;
  job_state?: string | null;
  job_country?: string | null;
  job_min_salary?: number | null;
  job_max_salary?: number | null;
  job_salary_currency?: string | null;
  job_salary_period?: string | null;
}

const DATE_MAP = { PAST_WEEK: "week", PAST_2_WEEKS: "month", PAST_MONTH: "month" } as const;
const TYPE_MAP = { FULL_TIME: "FULLTIME", PART_TIME: "PARTTIME", CONTRACT: "CONTRACTOR", INTERNSHIP: "INTERN" } as const;

const PAGE_SIZE = 10;

export async function searchJSearch(params: SearchParams, req: PageRequest, ctx: SearchContext): Promise<ProviderPage> {
  if (!env.JSEARCH_API_KEY) throw new ProviderError("JSEARCH", "JSEARCH_API_KEY is not set", true);

  const url = new URL(`https://${env.JSEARCH_API_HOST}/search`);
  url.searchParams.set("query", params.location ? `${params.query} in ${params.location}` : params.query);
  url.searchParams.set("page", String(req.page));
  url.searchParams.set("num_pages", String(req.pages));
  url.searchParams.set("country", params.country);
  url.searchParams.set("date_posted", DATE_MAP[params.datePosted as keyof typeof DATE_MAP] ?? "month");
  if (params.remoteOnly) url.searchParams.set("work_from_home", "true");
  const types = params.jobTypes.map((t) => TYPE_MAP[t as keyof typeof TYPE_MAP]).filter(Boolean);
  if (types.length) url.searchParams.set("employment_types", types.join(","));

  const res = await auditedFetch(url.toString(), {
    label: "JSearch /search",
    userId: ctx.userId,
    requestId: ctx.requestId,
    headers: { "x-rapidapi-key": env.JSEARCH_API_KEY, "x-rapidapi-host": env.JSEARCH_API_HOST },
    signal: AbortSignal.timeout(30_000),
  });

  const usage = { provider: "JSEARCH" as const, statusCode: res.status, userId: ctx.userId, requestId: ctx.requestId };
  if (!res.ok) {
    void recordSearchUsage({ ...usage, credits: 0 }); // failed requests are logged but not billed
    // 429 = quota used up, 5xx = provider outage -> both should fall back to SerpApi
    const retryable = res.status === 429 || res.status >= 500 || res.status === 403;
    throw new ProviderError("JSEARCH", `HTTP ${res.status}`, retryable);
  }

  const json = (await res.json()) as { status?: string; data?: JSearchJob[] };
  if (json.status && json.status !== "OK") throw new ProviderError("JSEARCH", `status ${json.status}`, true);

  const data = json.data ?? [];
  // JSearch bills each page of results (num_pages) as one request.
  void recordSearchUsage({ ...usage, credits: req.pages, resultCount: data.length });
  // A short last page means there is nothing after it, so a top-up would be wasted.
  return { jobs: data.map(toNormalized), hasMore: data.length >= req.pages * PAGE_SIZE };
}

function toNormalized(j: JSearchJob): NormalizedJob {
  const postedAt = j.job_posted_at_datetime_utc ? new Date(j.job_posted_at_datetime_utc) : null;
  const options = (j.apply_options?.length
    ? j.apply_options
    : [{ publisher: j.job_publisher ?? "", apply_link: j.job_apply_link, is_direct: !!j.job_apply_is_direct }]
  ).map((o) => ({
    publisher: o.publisher,
    url: o.apply_link,
    isDirect: o.is_direct,
    website: o.is_direct ? ("COMPANY_SITE" as const) : websiteFrom(o.publisher || o.apply_link),
  }));
  const location =
    j.job_location ?? ([j.job_city, j.job_state, j.job_country].filter(Boolean).join(", ") || null);

  return {
    externalId: `jsearch:${j.job_id}`,
    provider: "JSEARCH",
    positionName: j.job_title,
    companyName: j.employer_name,
    companyWebsite: j.employer_website ?? null,
    description: j.job_description ?? "",
    location,
    jobType: jobTypeFrom(j.job_employment_type),
    locationType: locationTypeFrom(j.job_is_remote, `${j.job_title} ${j.job_description ?? ""}`),
    postedAt,
    salaryMin: j.job_min_salary ?? null,
    salaryMax: j.job_max_salary ?? null,
    salaryCurrency: j.job_salary_currency ?? null,
    salaryPeriod: j.job_salary_period ?? null,
    applyOptions: options,
  };
}
