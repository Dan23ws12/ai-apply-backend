import { prisma } from "../lib/prisma.js";
import { notFound } from "../lib/errors.js";
import type { ApplicationStatus, Prisma } from "../generated/prisma/client.js";
import type { NormalizedJob } from "./search/types.js";

/**
 * Jobs are stored in two parts (see prisma/schema.prisma):
 *   job_postings (+ job_apply_options)  shared facts about the posting
 *   applications                       one user's application to it
 * The API still returns one flat "job" per application, in the same shape as before
 * the split, so API clients did not have to change.
 */

/** What to load with an application to build the flat job view. */
export const jobInclude = {
  posting: { include: { company: true, applyOptions: { orderBy: { createdAt: "asc" } } } },
  applyOption: true,
  applicationFiles: true,
} satisfies Prisma.ApplicationInclude;

export type ApplicationWithPosting = Prisma.ApplicationGetPayload<{ include: typeof jobInclude }>;

/** The flat "job" the API returns: application fields + posting fields + chosen apply link. */
export function toJobView(a: ApplicationWithPosting, opts: { withDescription?: boolean } = {}) {
  const p = a.posting;
  return {
    id: a.id,
    postingId: p.id,
    userId: a.userId,
    companyId: p.companyId,
    companyName: p.companyName,
    company: p.company,
    searchCriteriaId: a.searchCriteriaId,
    externalId: p.externalId,
    provider: p.provider,
    positionName: p.positionName,
    ...(opts.withDescription === false ? {} : { description: p.description }),
    location: p.location,
    jobType: p.jobType,
    locationType: p.locationType,
    searchWebsite: a.searchWebsite,
    applicationLink: a.applyOption.url,
    applyOptions: p.applyOptions.map((o) => ({ publisher: o.publisher, url: o.url, isDirect: o.isDirect, website: o.website })),
    salaryMin: p.salaryMin,
    salaryMax: p.salaryMax,
    salaryCurrency: p.salaryCurrency,
    salaryPeriod: p.salaryPeriod,
    postedAt: p.postedAt,
    fraudRating: p.fraudRating,
    fraudReason: p.fraudReason,
    fraudDetails: p.fraudDetails,
    matchRating: a.matchRating,
    matchReason: a.matchReason,
    matchDetails: a.matchDetails,
    applicationStatus: a.applicationStatus,
    statusMessage: a.statusMessage,
    applicationDate: a.applicationDate,
    applicationFiles: a.applicationFiles,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

/** The user's application with its posting, or 404. */
export async function ownApplication(userId: string, id: string): Promise<ApplicationWithPosting> {
  const app = await prisma.application.findFirst({ where: { id, userId }, include: jobInclude });
  if (!app) throw notFound("Job");
  return app;
}

type ExtraData = Omit<Prisma.ApplicationUncheckedUpdateInput, "applicationStatus" | "id">;

/**
 * Changes an application's status and records the change in application_status_events.
 * Use this for every status change so the history stays complete.
 */
export function setStatus(id: string, status: ApplicationStatus, extra: ExtraData = {}) {
  return prisma.$transaction(async (tx) => {
    const current = await tx.application.findUniqueOrThrow({ where: { id }, select: { applicationStatus: true } });
    const updated = await tx.application.update({ where: { id }, data: { ...extra, applicationStatus: status } });
    if (current.applicationStatus !== status) {
      await tx.applicationStatusEvent.create({
        data: {
          applicationId: id,
          fromStatus: current.applicationStatus,
          toStatus: status,
          message: typeof extra.statusMessage === "string" ? extra.statusMessage : null,
        },
      });
    }
    return updated;
  });
}

/** setStatus for many applications at once (e.g. when a company is blacklisted). */
export async function setStatusMany(where: Prisma.ApplicationWhereInput, status: ApplicationStatus, statusMessage: string) {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.application.findMany({ where, select: { id: true, applicationStatus: true } });
    if (!rows.length) return 0;
    await tx.application.updateMany({
      where: { id: { in: rows.map((r) => r.id) } },
      data: { applicationStatus: status, statusMessage },
    });
    await tx.applicationStatusEvent.createMany({
      data: rows
        .filter((r) => r.applicationStatus !== status)
        .map((r) => ({ applicationId: r.id, fromStatus: r.applicationStatus, toStatus: status, message: statusMessage })),
    });
    return rows.length;
  });
}

/**
 * Saves a posting found by a search (once for everyone) and its apply links.
 * An existing posting keeps its stored details and fraud rating; new apply links are added.
 */
export async function upsertPosting(j: NormalizedJob, companyId: string | null, companyName: string) {
  const posting = await prisma.jobPosting.upsert({
    where: { externalId: j.externalId },
    create: {
      externalId: j.externalId,
      provider: j.provider,
      companyId,
      companyName,
      positionName: j.positionName,
      description: j.description,
      location: j.location,
      jobType: j.jobType,
      locationType: j.locationType,
      salaryMin: j.salaryMin,
      salaryMax: j.salaryMax,
      salaryCurrency: j.salaryCurrency,
      salaryPeriod: j.salaryPeriod,
      postedAt: j.postedAt,
    },
    // Re-link the company if it was deleted and found again.
    update: companyId ? { companyId } : {},
  });
  if (j.applyOptions.length) {
    await prisma.jobApplyOption.createMany({
      data: j.applyOptions.map((o) => ({
        postingId: posting.id,
        publisher: o.publisher,
        url: o.url,
        isDirect: o.isDirect,
        website: o.website,
      })),
      skipDuplicates: true,
    });
  }
  const applyOptions = await prisma.jobApplyOption.findMany({ where: { postingId: posting.id } });
  return { ...posting, applyOptions };
}
