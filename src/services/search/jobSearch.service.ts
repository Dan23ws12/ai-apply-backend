import { createHash } from "node:crypto";
import { env } from "../../config/env.js";
import { HttpError } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import type { DatePostedRange, SearchCache, SearchCriteria, SearchProvider, SearchWebsite } from "../../generated/prisma/client.js";
import { matchesJobTypes } from "./normalize.js";
import { searchJSearch } from "./jsearch.provider.js";
import { searchSerpApi } from "./serpapi.provider.js";
import {
  ProviderError,
  type ApplyOption,
  type NormalizedJob,
  type PageRequest,
  type ProviderPage,
  type SearchContext,
  type SearchParams,
} from "./types.js";

/** Where the jobs of one search run came from. */
export type SearchSource = "api" | "cache" | "cache+api";

export interface SearchOutcome {
  provider: SearchProvider;
  source: SearchSource;
  apiCalled: boolean;
  /** Open jobs for this search before the run (see SEARCH_REFRESH_THRESHOLD). Null on a cache miss. */
  openJobs: number | null;
  /** Jobs held for this search (all cached pages), before the user's filters. */
  totalFound: number;
  /** Jobs that pass the user's filters. The caller drops ones the user already has. */
  jobs: NormalizedJob[];
  /** Set when a top-up call failed and cached jobs were used instead. */
  warning?: string;
}

export interface SearchOptions {
  /** Pages one API call asks for (user_settings.pagesPerSearch). */
  pages: number;
  /**
   * Counts the jobs still open for this user and search: cached jobs the user does not
   * have yet, plus saved jobs that are not applied, skipped or failed.
   * Receives the cached jobs that pass the user's filters.
   */
  countOpenJobs: (matching: NormalizedJob[]) => Promise<number>;
}

/**
 * Finds jobs for a saved search, calling the search APIs as little as possible:
 *
 * 1. No cached entry (or it expired after SEARCH_CACHE_TTL_HOURS): call the API for
 *    `pages` pages from page 1 and cache the result.
 * 2. Cached entry and at least SEARCH_REFRESH_THRESHOLD open jobs: no API call.
 * 3. Cached entry and fewer open jobs: fetch the NEXT `pages` pages (asking for page 1
 *    again would only return the jobs already cached) and add them to the entry. Stops
 *    when the provider runs out of pages or SEARCH_CACHE_MAX_PAGES is reached.
 *
 * Cached entries are shared by all users, because job postings are public.
 */
export async function searchJobs(criteria: SearchCriteria, ctx: SearchContext, opts: SearchOptions): Promise<SearchOutcome> {
  const { key, params } = searchKey(criteria);
  return withKeyLock(key, async (): Promise<SearchOutcome> => {
    const found = await prisma.searchCache.findUnique({ where: { cacheKey: key } });
    const entry = found && found.expiresAt > new Date() ? found : null;

    if (!entry) {
      const page = await fetchWithFallback(params, { page: 1, pages: opts.pages }, ctx);
      const jobs = dedupe(page.jobs);
      const data = cacheData(page, jobs, opts.pages);
      await prisma.searchCache.upsert({
        where: { cacheKey: key },
        create: { cacheKey: key, params: params as object, ...data, apiCalls: 1, expiresAt: expiry() },
        update: { params: params as object, ...data, apiCalls: { increment: 1 }, hitCount: 0, expiresAt: expiry() },
      });
      return {
        provider: page.provider,
        source: "api",
        apiCalled: true,
        openJobs: null,
        totalFound: jobs.length,
        jobs: applyFilters(jobs, criteria),
      };
    }

    const cached = readCachedJobs(entry);
    const matching = applyFilters(cached, criteria);
    const openJobs = await opts.countOpenJobs(matching);
    const roomLeft = env.SEARCH_CACHE_MAX_PAGES - entry.pagesFetched;
    const fromCache = (warning?: string): SearchOutcome => ({
      provider: entry.provider,
      source: "cache",
      apiCalled: false,
      openJobs,
      totalFound: cached.length,
      jobs: matching,
      ...(warning ? { warning } : {}),
    });

    if (openJobs >= env.SEARCH_REFRESH_THRESHOLD || entry.exhausted || roomLeft <= 0) {
      await prisma.searchCache.update({ where: { id: entry.id }, data: { hitCount: { increment: 1 } } });
      return fromCache();
    }

    // Top up with the next pages from the same provider, so page numbers / tokens line up.
    const pages = Math.min(opts.pages, roomLeft);
    let page: ProviderPage;
    try {
      page = await fetchFrom(entry.provider, params, { page: entry.pagesFetched + 1, pages, token: entry.nextPageToken }, ctx);
    } catch (err) {
      const message = (err as Error).message;
      logger.warn({ err: message, key }, "Search top-up failed; using cached jobs");
      return fromCache(`Could not fetch more jobs (${message}); showing cached jobs only`);
    }
    const jobs = dedupe([...cached, ...page.jobs]);
    await prisma.searchCache.update({
      where: { id: entry.id },
      data: {
        jobs: jobs as unknown as object[],
        pagesFetched: { increment: pages },
        nextPageToken: page.nextPageToken ?? null,
        exhausted: !page.hasMore || entry.pagesFetched + pages >= env.SEARCH_CACHE_MAX_PAGES,
        apiCalls: { increment: 1 },
        hitCount: { increment: 1 },
      },
    });
    return {
      provider: entry.provider,
      source: "cache+api",
      apiCalled: true,
      openJobs,
      totalFound: jobs.length,
      jobs: applyFilters(jobs, criteria),
    };
  });
}

/**
 * Cache key = the parameters actually sent to the APIs. Filters applied afterwards
 * (websites, keywords, salary, exact age) are left out, so searches that differ only in
 * those share one cache entry. PAST_2_WEEKS and PAST_MONTH both ask the APIs for "month".
 */
export function searchKey(criteria: SearchCriteria) {
  const tidy = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  const params: SearchParams = {
    query: tidy(criteria.query),
    location: criteria.location ? tidy(criteria.location) || null : null,
    country: criteria.country.toLowerCase(),
    // PAST_2_WEEKS and PAST_MONTH both ask the APIs for "month"; ALL_TIME asks for no date limit.
    datePosted: criteria.datePosted === "PAST_WEEK" || criteria.datePosted === "ALL_TIME" ? criteria.datePosted : "PAST_MONTH",
    remoteOnly: criteria.locationTypes.length === 1 && criteria.locationTypes[0] === "REMOTE",
    jobTypes: [...criteria.jobTypes].sort(),
  };
  const key = createHash("sha256").update(JSON.stringify(params)).digest("hex");
  return { key, params };
}

function expiry() {
  return new Date(Date.now() + env.SEARCH_CACHE_TTL_HOURS * 60 * 60 * 1000);
}

function cacheData(page: ProviderPage & { provider: SearchProvider }, jobs: NormalizedJob[], pages: number) {
  return {
    provider: page.provider,
    jobs: jobs as unknown as object[],
    pagesFetched: pages,
    nextPageToken: page.nextPageToken ?? null,
    exhausted: !page.hasMore || pages >= env.SEARCH_CACHE_MAX_PAGES,
  };
}

/** Cached jobs come back from JSON, so dates are strings again. */
function readCachedJobs(entry: SearchCache): NormalizedJob[] {
  const rows = Array.isArray(entry.jobs) ? (entry.jobs as unknown as NormalizedJob[]) : [];
  return rows.map((j) => ({ ...j, postedAt: j.postedAt ? new Date(j.postedAt) : null }));
}

function dedupe(jobs: NormalizedJob[]): NormalizedJob[] {
  const seen = new Set<string>();
  return jobs.filter((j) => {
    if (seen.has(j.externalId)) return false;
    seen.add(j.externalId);
    return true;
  });
}

/** Runs one search key at a time, so two users running the same search make one API call. */
const locks = new Map<string, Promise<unknown>>();
async function withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (locks.get(key) ?? Promise.resolve()).catch(() => undefined).then(fn);
  locks.set(key, run);
  try {
    return await run;
  } finally {
    if (locks.get(key) === run) locks.delete(key);
  }
}

function fetchFrom(provider: SearchProvider, params: SearchParams, req: PageRequest, ctx: SearchContext) {
  return provider === "JSEARCH" ? searchJSearch(params, req, ctx) : searchSerpApi(params, req, ctx);
}

/** JSearch first; SerpApi Google Jobs when JSearch is not configured, out of quota, down, or returns nothing. */
async function fetchWithFallback(
  params: SearchParams,
  req: PageRequest,
  ctx: SearchContext,
): Promise<ProviderPage & { provider: SearchProvider }> {
  if (!env.JSEARCH_API_KEY && !env.SERPAPI_API_KEY) {
    throw new HttpError(503, "No job search API is configured. Set JSEARCH_API_KEY and/or SERPAPI_API_KEY in .env");
  }

  try {
    const page = await searchJSearch(params, req, ctx);
    if (!page.jobs.length) throw new ProviderError("JSEARCH", "no results", true);
    return { ...page, provider: "JSEARCH" };
  } catch (jsearchErr) {
    logger.warn({ err: (jsearchErr as Error).message }, "JSearch failed; trying SerpApi");
    const noResults = jsearchErr instanceof ProviderError && jsearchErr.message.endsWith("no results");
    if (!env.SERPAPI_API_KEY) {
      if (noResults) return { jobs: [], hasMore: false, nextPageToken: null, provider: "JSEARCH" };
      throw new HttpError(502, `Job search failed (${(jsearchErr as Error).message}) and SERPAPI_API_KEY is not set`);
    }
    try {
      return { ...(await searchSerpApi(params, req, ctx)), provider: "SERPAPI" };
    } catch (serpErr) {
      throw new HttpError(502, `Job search failed. ${(jsearchErr as Error).message}; ${(serpErr as Error).message}`);
    }
  }
}

export const DAY_MS = 24 * 60 * 60 * 1000;
/** Oldest posting age kept for each date range, in days. null = no limit (ALL_TIME). */
export const MAX_AGE_DAYS: Record<DatePostedRange, number | null> = { PAST_WEEK: 7, PAST_2_WEEKS: 14, PAST_MONTH: 30, ALL_TIME: null };

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

    if (!listedOn(job, c.websites)) return false;
    if (c.locationTypes.length && !c.locationTypes.includes(job.locationType) && job.locationType !== "UNKNOWN") return false;
    if (!matchesJobTypes(job, c.jobTypes)) return false;
    if (include.length && !include.some((k) => text.includes(k))) return false;
    if (exclude.some((k) => text.includes(k))) return false;
    if (c.minSalary && job.salaryMax && job.salaryPeriod === "YEAR" && job.salaryMax < c.minSalary) return false;
    // The APIs only filter by week or month, so check the exact age here. Jobs with no date are kept.
    const maxAge = MAX_AGE_DAYS[c.datePosted];
    if (maxAge !== null && job.postedAt && Date.now() - job.postedAt.getTime() > maxAge * DAY_MS) return false;
    return true;
  });
}

/**
 * True when the job is on one of the chosen boards. A LinkedIn, Glassdoor or Indeed posting
 * whose apply button sends you to the company's careers site (or Workday, Greenhouse, etc.)
 * counts as listed on that board, even if the search API only returned the external link.
 */
function listedOn(job: NormalizedJob, websites: SearchWebsite[]): boolean {
  if (!websites.length) return true;
  return boardWebsite(job, websites) !== undefined;
}

/** The chosen board the job was found on: an apply link on that board first, then the publisher. */
export function boardWebsite(
  job: Pick<NormalizedJob, "applyOptions" | "listedOn">,
  websites: readonly string[],
): SearchWebsite | undefined {
  const option = job.applyOptions.find((o) => websites.includes(o.website));
  if (option) return option.website;
  return job.listedOn && websites.includes(job.listedOn) ? job.listedOn : undefined;
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
