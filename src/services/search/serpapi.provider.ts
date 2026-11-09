import { createHash } from "node:crypto";
import { env } from "../../config/env.js";
import { auditedFetch } from "../audit.service.js";
import {
  isLikelyCompanySite,
  jobTypeFrom,
  locationTypeFrom,
  parseRelativeDate,
  websiteFrom,
} from "./normalize.js";
import { ProviderError, type NormalizedJob, type SearchContext, type SearchParams } from "./types.js";

/** Backup provider: SerpApi Google Jobs. Docs: https://serpapi.com/google-jobs-api */

interface SerpJob {
  job_id?: string;
  title: string;
  company_name: string;
  location?: string;
  via?: string;
  description?: string;
  share_link?: string;
  detected_extensions?: {
    posted_at?: string;
    schedule_type?: string;
    work_from_home?: boolean;
    salary?: string;
  };
  apply_options?: { title: string; link: string }[];
}

interface SerpResponse {
  error?: string;
  jobs_results?: SerpJob[];
  serpapi_pagination?: { next_page_token?: string };
}

export async function searchSerpApi(params: SearchParams, ctx: SearchContext): Promise<NormalizedJob[]> {
  if (!env.SERPAPI_API_KEY) throw new ProviderError("SERPAPI", "SERPAPI_API_KEY is not set", false);

  const jobs: NormalizedJob[] = [];
  let nextPageToken: string | undefined;

  // Google Jobs returns 10 results per page.
  for (let page = 0; page < Math.min(Math.ceil(params.maxResults / 10), 5); page++) {
    const url = new URL("https://serpapi.com/search.json");
    url.searchParams.set("engine", "google_jobs");
    url.searchParams.set("q", params.query);
    if (params.location) url.searchParams.set("location", params.location);
    url.searchParams.set("gl", params.country);
    url.searchParams.set("hl", "en");
    if (params.remoteOnly) url.searchParams.set("ltype", "1");
    if (nextPageToken) url.searchParams.set("next_page_token", nextPageToken);
    url.searchParams.set("api_key", env.SERPAPI_API_KEY);

    const res = await auditedFetch(url.toString(), {
      label: "SerpApi google_jobs",
      userId: ctx.userId,
      requestId: ctx.requestId,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new ProviderError("SERPAPI", `HTTP ${res.status}`, res.status >= 500);

    const json = (await res.json()) as SerpResponse;
    if (json.error) {
      // "Google hasn't returned any results" is not a failure, just an empty page.
      if (/hasn't returned any results/i.test(json.error)) break;
      throw new ProviderError("SERPAPI", json.error, false);
    }

    for (const j of json.jobs_results ?? []) jobs.push(toNormalized(j));
    nextPageToken = json.serpapi_pagination?.next_page_token;
    if (!nextPageToken || jobs.length >= params.maxResults) break;
  }
  return jobs;
}

function toNormalized(j: SerpJob): NormalizedJob {
  const postedAt = parseRelativeDate(j.detected_extensions?.posted_at);
  const options = (j.apply_options ?? []).map((o) => {
    const direct = isLikelyCompanySite(`${o.title} ${o.link}`);
    return {
      publisher: o.title,
      url: o.link,
      isDirect: direct,
      website: direct ? ("COMPANY_SITE" as const) : websiteFrom(o.title || o.link),
    };
  });
  if (!options.length && j.share_link) {
    options.push({ publisher: j.via ?? "Google Jobs", url: j.share_link, isDirect: false, website: websiteFrom(j.via) });
  }
  const salary = parseSalary(j.detected_extensions?.salary);
  const externalId =
    j.job_id ?? createHash("sha1").update(`${j.title}|${j.company_name}|${j.location}`).digest("hex");

  return {
    externalId: `serpapi:${externalId.slice(0, 200)}`,
    provider: "SERPAPI",
    positionName: j.title,
    companyName: j.company_name,
    companyWebsite: null,
    description: j.description ?? "",
    location: j.location ?? null,
    jobType: jobTypeFrom(j.detected_extensions?.schedule_type),
    locationType: locationTypeFrom(j.detected_extensions?.work_from_home ?? null, `${j.title} ${j.location ?? ""} ${j.description ?? ""}`),
    postedAt,
    ...salary,
    applyOptions: options,
  };
}

/** "60K–80K a year" / "$25–$30 an hour" -> numbers. Best effort only. */
function parseSalary(text?: string) {
  const empty = { salaryMin: null, salaryMax: null, salaryCurrency: null, salaryPeriod: null };
  if (!text) return empty;
  const nums = [...text.matchAll(/(\d+(?:[.,]\d+)?)\s*([kK])?/g)].map((m) => {
    const n = Number(m[1]!.replace(",", ""));
    return m[2] ? n * 1000 : n;
  });
  if (!nums.length) return empty;
  const period = /hour/i.test(text) ? "HOUR" : /month/i.test(text) ? "MONTH" : /year|annum/i.test(text) ? "YEAR" : null;
  return {
    salaryMin: Math.round(nums[0]!),
    salaryMax: Math.round(nums[1] ?? nums[0]!),
    salaryCurrency: text.includes("$") ? "USD/CAD" : null,
    salaryPeriod: period,
  };
}
