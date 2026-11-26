import { existsSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { HttpError, notFound } from "../lib/errors.js";
import { aiClient, FraudResult, MatchResult } from "./ai.client.js";
import { cachedEvaluation } from "./evaluationCache.service.js";
import { audit } from "./audit.service.js";
import { jobForAi, loadApplicant, postingForAi } from "./applicant.service.js";
import { blacklistedCompanyNames, isBlacklisted } from "./blacklist.service.js";
import { jobInclude, setStatus, upsertPosting } from "./jobs.service.js";
import { getUserSettings } from "./settings.service.js";
import { DAY_MS, MAX_AGE_DAYS, pickApplyOption, searchJobs } from "./search/jobSearch.service.js";
import { normalizeCompanyName } from "./search/normalize.js";
import { applicationKey, findApplied } from "./applicationLedger.service.js";

interface Ctx {
  userId: string;
  requestId?: string;
}

/** Saved applications in these statuses still need the user's attention, so they count as open. */
export const OPEN_STATUSES = ["FOUND", "DOCUMENTS_READY", "FORM_FILLED", "SAVED", "INCOMPLETE"] as const;

/**
 * Step 1 (runs during the HTTP request): find jobs (cache first, API only when needed),
 * filter, and save up to the user's jobsPerSearch new jobs.
 * Each job is saved as a shared posting (once for everyone) plus this user's application.
 * Step 2 (runs in the background): score each new job, then create documents for good matches.
 */
export async function runSearchCriteria(criteriaId: string, ctx: Ctx) {
  const criteria = await prisma.searchCriteria.findFirst({ where: { id: criteriaId, userId: ctx.userId } });
  if (!criteria) throw notFound("Search criteria");

  const settings = await getUserSettings(ctx.userId);
  const limit = criteria.maxResults ?? settings.jobsPerSearch;
  const blockedNames = await blacklistedCompanyNames(ctx.userId);
  const companyKey = (name: string) => normalizeCompanyName(name) || name.toLowerCase();
  /** externalIds (of these) the user already has an application for, in any status. */
  const ownExternalIds = async (ids: string[]) =>
    new Set(
      (
        await prisma.application.findMany({
          where: { userId: ctx.userId, posting: { externalId: { in: ids } } },
          select: { posting: { select: { externalId: true } } },
        })
      ).map((r) => r.posting.externalId),
    );

  const outcome = await searchJobs(criteria, ctx, {
    pages: settings.pagesPerSearch,
    countOpenJobs: async (matching) => {
      const ids = matching.map((j) => j.externalId);
      const owned = await ownExternalIds(ids);
      // Cached jobs this user doesn't have yet and could still apply to.
      const unsaved = matching.filter(
        (j) =>
          !owned.has(j.externalId) &&
          !blockedNames.has(companyKey(j.companyName)) &&
          !!pickApplyOption(j.applyOptions, criteria.websites),
      ).length;
      // Saved applications for this search that are not applied, skipped or failed, and still recent enough.
      const maxAge = MAX_AGE_DAYS[criteria.datePosted];
      const cutoff = maxAge === null ? null : new Date(Date.now() - maxAge * DAY_MS);
      const saved = await prisma.application.count({
        where: {
          userId: ctx.userId,
          applicationStatus: { in: [...OPEN_STATUSES] },
          OR: [{ searchCriteriaId: criteria.id }, { posting: { externalId: { in: ids } } }],
          ...(cutoff ? { posting: { OR: [{ postedAt: null }, { postedAt: { gte: cutoff } }] } } : {}),
        },
      });
      return unsaved + saved;
    },
  });

  const owned = await ownExternalIds(outcome.jobs.map((j) => j.externalId));
  const newJobIds: string[] = [];
  let skipped = 0;
  let skippedApplied = 0;

  for (const j of outcome.jobs) {
    if (newJobIds.length >= limit) break;
    if (owned.has(j.externalId)) continue;
    const apply = pickApplyOption(j.applyOptions, criteria.websites);
    if (!apply) continue;

    const normalizedName = companyKey(j.companyName);
    const company = await prisma.company.upsert({
      where: { normalizedName },
      create: { name: j.companyName, normalizedName, websiteUrl: j.companyWebsite },
      update: j.companyWebsite ? { websiteUrl: j.companyWebsite } : {},
    });
    const posting = await upsertPosting(j, company.id, j.companyName);
    const applyOption = posting.applyOptions.find((o) => o.url === apply.url);
    if (!applyOption) continue;
    const listedOn = j.applyOptions.find((o) => criteria.websites.includes(o.website)) ?? apply;
    const blacklisted = blockedNames.has(normalizedName);
    // Same position, company and location already applied to (e.g. a re-post, or found by the other search API).
    const appliedBefore = blacklisted ? null : findApplied(applicationKey(ctx.userId, j.companyName, j.positionName, j.location));
    const status = blacklisted || appliedBefore ? ("SKIPPED" as const) : ("FOUND" as const);
    const statusMessage = blacklisted
      ? "Company is blacklisted"
      : appliedBefore
        ? `Already applied (${appliedBefore.applicationKey} on ${appliedBefore.dateApplied.toISOString().slice(0, 10)})`
        : null;

    const app = await prisma.application.create({
      data: {
        userId: ctx.userId,
        postingId: posting.id,
        searchCriteriaId: criteria.id,
        applyOptionId: applyOption.id,
        searchWebsite: listedOn.website,
        applicationStatus: status,
        statusMessage,
        statusEvents: { create: { fromStatus: null, toStatus: status, message: statusMessage ?? "Found by search" } },
      },
    });
    // Blacklisted and already-applied jobs are saved as SKIPPED (so they are not offered again)
    // but don't use up the limit.
    if (blacklisted) skipped++;
    else if (appliedBefore) skippedApplied++;
    else newJobIds.push(app.id);
  }

  await prisma.searchCriteria.update({ where: { id: criteria.id }, data: { lastRunAt: new Date() } });

  // Background work: don't make the HTTP request wait for AI calls.
  void processJobs(newJobIds, criteria, ctx);

  return {
    provider: outcome.provider,
    source: outcome.source,
    apiCalled: outcome.apiCalled,
    openJobsBefore: outcome.openJobs,
    totalFound: outcome.totalFound,
    limit,
    saved: newJobIds.length,
    skippedBlacklisted: skipped,
    skippedAlreadyApplied: skippedApplied,
    jobIds: newJobIds,
    ...(outcome.warning ? { warning: outcome.warning } : {}),
  };
}

async function processJobs(
  jobIds: string[],
  criteria: { minMatchRating: number; maxFraudRating: number; autoGenerateDocs: boolean },
  ctx: Ctx,
) {
  for (const jobId of jobIds) {
    try {
      const { fraud, match } = await evaluateJob(jobId, ctx);
      if (!match) continue; // fraud >= 80: already marked SKIPPED by evaluateJob

      // The two ratings were worked out independently; each search's limits decide what happens next.
      const reasons: string[] = [];
      if (match.match_rating < criteria.minMatchRating) reasons.push(`match ${match.match_rating} is below ${criteria.minMatchRating}`);
      if (fraud.fraud_rating > criteria.maxFraudRating) reasons.push(`fraud ${fraud.fraud_rating} is above ${criteria.maxFraudRating}`);
      if (reasons.length) {
        await setStatus(jobId, "SKIPPED", { statusMessage: `Skipped: ${reasons.join("; ")}` });
        continue;
      }
      if (criteria.autoGenerateDocs) await generateDocuments(jobId, ctx, match);
    } catch (err) {
      logger.error({ err, jobId }, "Processing job failed");
      await markError(jobId, err, ctx);
    }
  }
}

/** Fraud ratings at or above this skip the match rating (job-post-evaluation skill). */
export const SKIP_MATCH_FRAUD_RATING = 80;

/**
 * Hybrid job evaluation, in two independent steps:
 *  1. Fraud likelihood rating (1-100, higher = more likely a scam). Uses only the posting,
 *     and is stored on the shared posting (job_postings) for every user.
 *  2. Job match rating (1-100, higher = better fit). Uses only the posting and the resumes,
 *     never the fraud result, and is stored on this user's application. Skipped when the
 *     fraud rating is 80 or more.
 *
 * Both ratings are cached (see evaluationCache.service.ts) and shared across users, so the
 * same posting is only sent to the AI once. `refresh` ignores the cache and asks again.
 * `jobId` is the application id (the API calls applications "jobs").
 */
export async function evaluateJob(
  jobId: string,
  ctx: Ctx,
  opts: { refresh?: boolean } = {},
): Promise<{ fraud: FraudResult; match: MatchResult | null; cached: { fraud: boolean; match: boolean | null } }> {
  const app = await prisma.application.findFirst({ where: { id: jobId, userId: ctx.userId }, include: jobInclude });
  if (!app) throw notFound("Job");
  const posting = app.posting;

  const fraudInput = postingForAi(posting);
  const { result: fraud, cached: fraudCached } = await cachedEvaluation(
    "FRAUD",
    fraudInput,
    FraudResult,
    () => aiClient.fraud(fraudInput, ctx),
    opts,
  );
  await prisma.jobPosting.update({
    where: { id: posting.id },
    data: {
      fraudRating: fraud.fraud_rating,
      fraudReason: fraud.reasoning,
      fraudDetails: { red_flags: fraud.red_flags, checks: fraud.checks } as object,
      fraudEvaluatedAt: new Date(),
    },
  });

  if (fraud.fraud_rating >= SKIP_MATCH_FRAUD_RATING) {
    // A posting that is very likely a scam gets no match rating at all.
    await setStatus(jobId, "SKIPPED", {
      matchRating: null,
      matchReason: null,
      matchDetails: Prisma.DbNull,
      statusMessage: `Very likely a scam (fraud rating ${fraud.fraud_rating}/100); match rating skipped`,
    });
    return { fraud, match: null, cached: { fraud: fraudCached, match: null } };
  }

  const profile = await prisma.userProfile.findUnique({ where: { userId: ctx.userId } });
  const matchInput = {
    title: posting.positionName,
    company: posting.company?.name ?? posting.companyName,
    description: posting.description ?? "",
    location: posting.location,
    preferred_category: profile?.defaultResumeCategory ?? null,
  };
  const { result: match, cached: matchCached } = await cachedEvaluation(
    "MATCH",
    matchInput,
    MatchResult,
    () => aiClient.match(matchInput, ctx),
    opts,
  );
  await prisma.application.update({
    where: { id: jobId },
    data: {
      matchRating: match.match_rating,
      matchReason: match.reasoning,
      matchDetails: {
        resume_category: match.resume_category,
        no_track_fits: match.no_track_fits,
        keywords: match.keywords,
        ...match.details,
      } as object,
    },
  });
  return { fraud, match, cached: { fraud: fraudCached, match: matchCached } };
}

/** Track and keywords saved by the last match rating, if any. */
function savedMatch(details: unknown): { resume_category: string; keywords: string[] } | null {
  const d = details as { resume_category?: unknown; keywords?: unknown } | null;
  if (d && typeof d.resume_category === "string" && Array.isArray(d.keywords)) {
    return { resume_category: d.resume_category, keywords: d.keywords.filter((k): k is string => typeof k === "string") };
  }
  return null;
}

/** A file inside an application-docs subfolder (not the application-docs root itself). */
function isApplicationDoc(filePath: string): boolean {
  const parts = path.normalize(filePath).split(path.sep).filter(Boolean);
  const idx = parts.lastIndexOf("application-docs");
  return idx >= 0 && idx < parts.length - 2;
}

/**
 * Removes the previous AI resume and cover letter when regeneration writes a different folder.
 * Only paths that still match the stored AI links and sit under application-docs are deleted.
 * Uploads and older files in resumes/jb resumes or cover-letters are left alone.
 */
function removeReplacedAiFolder(oldPaths: Array<string | null | undefined>, newResumePath: string) {
  const newDir = path.resolve(path.dirname(newResumePath));
  const dirs = new Set<string>();
  for (const file of oldPaths) {
    if (!file || !isApplicationDoc(file)) continue;
    const dir = path.resolve(path.dirname(file));
    if (dir === newDir) continue;
    dirs.add(dir);
    try {
      if (existsSync(file)) unlinkSync(file);
    } catch (err) {
      logger.warn({ err, file }, "Could not remove the previous application document");
    }
  }
  for (const dir of dirs) {
    try {
      const note = path.join(dir, "job.txt");
      if (existsSync(note)) unlinkSync(note);
      removeEmptyUpToDocsRoot(dir);
    } catch (err) {
      logger.warn({ err, dir }, "Could not remove the previous application folder");
    }
  }
}

/** Removes an empty application folder, then its date folder when that day has nothing left. */
function removeEmptyUpToDocsRoot(start: string) {
  let current = start;
  while (path.basename(current) !== "application-docs") {
    if (!existsSync(current) || readdirSync(current).length > 0) break;
    const parent = path.dirname(current);
    rmdirSync(current);
    current = parent;
  }
}

/** Creates a tailored resume + cover letter and stores the links in application_files. */
export async function generateDocuments(
  jobId: string,
  ctx: Ctx,
  scored?: { resume_category: string; keywords: string[] },
) {
  const app = await prisma.application.findFirst({ where: { id: jobId, userId: ctx.userId }, include: jobInclude });
  if (!app) throw notFound("Job");
  const fraudRating = app.posting.fraudRating;
  if (await isBlacklisted(ctx.userId, app.posting.companyId)) throw new HttpError(409, "Company is blacklisted");
  if (fraudRating != null && fraudRating >= SKIP_MATCH_FRAUD_RATING) {
    throw new HttpError(409, `This posting is very likely a scam (fraud rating ${fraudRating}/100)`);
  }

  let score = scored ?? savedMatch(app.matchDetails);
  if (!score) {
    const { match } = await evaluateJob(jobId, ctx);
    if (!match) throw new HttpError(409, "This posting is very likely a scam; documents were not created");
    score = match;
  }
  const applicant = await loadApplicant(ctx.userId);
  const docs = await aiClient.documents(
    { job_id: app.id, job: jobForAi(app), applicant, resume_category: score.resume_category, keywords: score.keywords },
    ctx,
  );

  // Regenerating replaces the AI versions but keeps a custom file the user picked.
  const existing = app.applicationFiles;
  const resumeIsCustom = !!existing?.resumeLink && existing.resumeLink !== existing.aiResumeLink;
  const coverIsCustom = !!existing?.coverLetterLink && existing.coverLetterLink !== existing.aiCoverLetterLink;
  const data = {
    resumeLink: resumeIsCustom ? existing!.resumeLink : docs.resume_path,
    coverLetterLink: coverIsCustom ? existing!.coverLetterLink : docs.cover_letter_path,
    aiResumeLink: docs.resume_path,
    aiCoverLetterLink: docs.cover_letter_path,
    baseResumeCategory: docs.resume_category,
    keywordsUsed: docs.keywords_used,
  };
  const files = await prisma.applicationFile.upsert({
    where: { applicationId: jobId },
    create: { applicationId: jobId, ...data },
    update: data,
  });

  removeReplacedAiFolder([existing?.aiResumeLink, existing?.aiCoverLetterLink], docs.resume_path);

  await setStatus(jobId, "DOCUMENTS_READY", { statusMessage: null });
  return files;
}

export async function markError(jobId: string, err: unknown, ctx: Ctx) {
  const message = (err as Error)?.message ?? String(err);
  audit({ type: "ERROR", userId: ctx.userId, requestId: ctx.requestId, message: `job ${jobId}: ${message}` });
  await setStatus(jobId, "ERROR", { statusMessage: message.slice(0, 2000) }).catch(() => undefined);
}
