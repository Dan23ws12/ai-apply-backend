import { env } from "../../config/env.js";
import { auditedFetch } from "../audit.service.js";
import {
  jobTypeFrom,
  locationTypeFrom,
  websiteFrom,
} from "./normalize.js";
import { ProviderError, type NormalizedJob, type SearchContext, type SearchParams } from "./types.js";

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

export async function searchJSearch(params: SearchParams, ctx: SearchContext): Promise<NormalizedJob[]> {
  if (!env.JSEARCH_API_KEY) throw new ProviderError("JSEARCH", "JSEARCH_API_KEY is not set", true);

  const url = new URL(`https://${env.JSEARCH_API_HOST}/search`);
  url.searchParams.set("query", params.location ? `${params.query} in ${params.location}` : params.query);
  url.searchParams.set("page", "1");
  url.searchParams.set("num_pages", String(Math.min(Math.ceil(params.maxResults / 10), 5)));
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

  if (!res.ok) {
    // 429 = quota used up, 5xx = provider outage -> both should fall back to SerpApi
    const retryable = res.status === 429 || res.status >= 500 || res.status === 403;
    throw new ProviderError("JSEARCH", `HTTP ${res.status}`, retryable);
  }

  const json = (await res.json()) as { status?: string; data?: JSearchJob[] };
  if (json.status && json.status !== "OK") throw new ProviderError("JSEARCH", `status ${json.status}`, true);

  return (json.data ?? []).map((j): NormalizedJob => {
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
  });
}
