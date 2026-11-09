import { prisma } from "../lib/prisma.js";

/** Rows in the "blacklisted" table are per user: one user's blacklist never affects another user. */

export async function isBlacklisted(userId: string, companyId: string | null | undefined): Promise<boolean> {
  if (!companyId) return false;
  const row = await prisma.blacklisted.findUnique({
    where: { userId_companyId: { userId, companyId } },
    select: { id: true },
  });
  return !!row;
}

export async function blacklistedCompanyIds(userId: string): Promise<Set<string>> {
  const rows = await prisma.blacklisted.findMany({ where: { userId }, select: { companyId: true } });
  return new Set(rows.map((r) => r.companyId));
}

/** Adds the company to the user's blacklist and skips the user's open jobs there. */
export async function blacklistCompany(userId: string, companyId: string) {
  const row = await prisma.blacklisted.upsert({
    where: { userId_companyId: { userId, companyId } },
    create: { userId, companyId },
    update: {},
  });
  await prisma.job.updateMany({
    where: { companyId, userId, applicationStatus: { in: ["FOUND", "DOCUMENTS_READY", "SAVED"] } },
    data: { applicationStatus: "SKIPPED", statusMessage: "Company is blacklisted" },
  });
  return row;
}

export async function unblacklistCompany(userId: string, companyId: string) {
  await prisma.blacklisted.deleteMany({ where: { userId, companyId } });
}
