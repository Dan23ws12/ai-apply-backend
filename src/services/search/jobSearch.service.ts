import { env } from "../../config/env.js";
import { HttpError } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import type { SearchCriteria, SearchWebsite } from "../../generated/prisma/client.js";
import { searchJSearch } from "./jsearch.provider.js";
import { searchSerpApi } from "./serpapi.provider.js";
import { ProviderError, type ApplyOption, type NormalizedJob, type SearchContext } from "./types.js";

/**
 * Runs a search with JSearch first and falls back to SerpApi Google Jobs when
 * JSearch is not configured, out of quota, down, or returns nothing.
 */
export async function searchJobs(criteria: SearchCriteria, ctx: SearchContext) {
  const params = {
    query: criteria.query,
    location: criteria.location,
    country: criteria.country,
    datePosted: criteria.datePosted,
    remoteOnly: criteria.locationTypes.length === 1 && criteria.locationTypes[0] === "REMOTE",
    jobTypes: criteria.jobTypes,
    // Ask for extra results because the filters below remove some.
    maxResults: Math.min(criteria.maxResults * 2, 50),
  };

  if (!env.JSEARCH_API_KEY && !env.SERPAPI_API_KEY) {
    throw new HttpError(503, "No job search API is configured. Set JSEARCH_API_KEY and/or SERPAPI_API_KEY in .env");
  }

  let jobs: NormalizedJob[] = [];
  let provider: "JSEARCH" | "SERPAPI" = "JSEARCH";
  try {
    jobs = await searchJSearch(params, ctx);
    if (!jobs.length) throw new ProviderError("JSEARCH", "no results", true);
  } catch (jsearchErr) {
    logger.warn({ err: (jsearchErr as Error).message }, "JSearch failed; trying SerpApi");
    if (!env.SERPAPI_API_KEY) {
      if (jsearchErr instanceof ProviderError && jsearchErr.message.endsWith("no results")) jobs = [];
      else throw new HttpError(502, `Job search failed (${(jsearchErr as Error).message}) and SERPAPI_API_KEY is not set`);
    } else {
      provider = "SERPAPI";
      try {
        jobs = await searchSerpApi(params, ctx);
      } catch (serpErr) {
        throw new HttpError(502, `Job search failed. ${(jsearchErr as Error).message}; ${(serpErr as Error).message}`);
      }
    }
  }

  const filtered = applyFilters(jobs, criteria).slice(0, criteria.maxResults);
  return { provider, totalFound: jobs.length, jobs: filtered };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_AGE_DAYS = { PAST_WEEK: 7, PAST_2_WEEKS: 14, PAST_MONTH: 30 } as const;

/** Applies the user's criteria that the search APIs cannot filter on. */
export function applyFilters(jobs: NormalizedJob[], c: SearchCriteria): NormalizedJob[] {
  const include = c.includeKeywords.map((k) => k.toLowerCase());
  const exclude = c.excludeKeywords.map((k) => k.toLowerCase());
  const seen = new Set<string>();

  return jobs.filter((job) => {
    const text = `${job.positionName} ${job.description}`.toLowerCase();
    const key = `${job.positionName}|${job.companyName}`.toLowerCase();
    if (seen.has(key)) return false; // same job listed on several boards
    seen.add(key);

    if (!listedOn(job.applyOptions, c.websites)) return false;
    if (c.locationTypes.length && !c.locationTypes.includes(job.locationType) && job.locationType !== "UNKNOWN") return false;
    if (c.jobTypes.length && !c.jobTypes.includes(job.jobType) && job.jobType !== "UNKNOWN") return false;
    if (include.length && !include.some((k) => text.includes(k))) return false;
    if (exclude.some((k) => text.includes(k))) return false;
    if (c.minSalary && job.salaryMax && job.salaryPeriod === "YEAR" && job.salaryMax < c.minSalary) return false;
    // The APIs only filter by week or month, so check the exact age here. Jobs with no date are kept.
    if (job.postedAt && Date.now() - job.postedAt.getTime() > MAX_AGE_DAYS[c.datePosted] * DAY_MS) return false;
    return true;
  });
}

function listedOn(options: ApplyOption[], websites: SearchWebsite[]): boolean {
  if (!websites.length) return true;
  return options.some((o) => websites.includes(o.website));
}

/**
 * Picks the link to open for the application. With PREFER_DIRECT_APPLY the company's
 * own careers page is chosen over LinkedIn/Glassdoor, which keeps automation off those sites.
 */
export function pickApplyOption(options: ApplyOption[], websites: SearchWebsite[]): ApplyOption | undefined {
  if (env.PREFER_DIRECT_APPLY) {
    const direct = options.find((o) => o.isDirect);
    if (direct) return direct;
  }
  return options.find((o) => websites.includes(o.website)) ?? options[0];
}
