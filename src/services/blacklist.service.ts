import { prisma } from "../lib/prisma.js";
import { setStatusMany } from "./jobs.service.js";
import { companyBlacklistKeys, isBlockedName } from "./search/companyName.js";

/**
 * Rows in the "blacklisted" table are per user: one user's blacklist never affects another user.
 *
 * A blacklist entry keeps its country. Blacklisting "DoorDash" also covers "DoorDash Canada",
 * "DoorDash UK" and so on; blacklisting "DoorDash Canada" covers only that one
 * (see search/companyName.ts).
 */

const OPEN_FOR_BLACKLIST = ["FOUND", "DOCUMENTS_READY", "SAVED"] as const;

export async function isBlacklisted(userId: string, companyId: string | null | undefined): Promise<boolean> {
  if (!companyId) return false;
  const row = await prisma.blacklisted.findUnique({
    where: { userId_companyId: { userId, companyId } },
    select: { id: true },
  });
  if (row) return true;
  // A country branch of a blacklisted company ("DoorDash Canada" when "DoorDash" is blacklisted).
  const company = await prisma.company.findUnique({ where: { id: companyId }, select: { name: true } });
  return !!company && isBlockedName(await blacklistedCompanyNames(userId), company.name);
}

export async function blacklistedCompanyIds(userId: string): Promise<Set<string>> {
  const rows = await prisma.blacklisted.findMany({ where: { userId }, select: { companyId: true } });
  return new Set(rows.map((r) => r.companyId));
}

/** Normalised names of the user's blacklisted companies (to check jobs not saved yet). */
export async function blacklistedCompanyNames(userId: string): Promise<Set<string>> {
  const rows = await prisma.blacklisted.findMany({
    where: { userId },
    select: { company: { select: { normalizedName: true } } },
  });
  return new Set(rows.map((r) => r.company.normalizedName));
}

/**
 * Adds the company to the user's blacklist and skips the user's open jobs there, including
 * jobs at its country branches ("DoorDash Canada" when "DoorDash" is blacklisted).
 */
export async function blacklistCompany(userId: string, companyId: string) {
  const row = await prisma.blacklisted.upsert({
    where: { userId_companyId: { userId, companyId } },
    create: { userId, companyId },
    update: {},
    include: { company: { select: { normalizedName: true } } },
  });
  await setStatusMany(
    { userId, posting: { companyId }, applicationStatus: { in: [...OPEN_FOR_BLACKLIST] } },
    "SKIPPED",
    "Company is blacklisted",
  );

  const key = row.company.normalizedName;
  const others = await prisma.application.findMany({
    where: { userId, applicationStatus: { in: [...OPEN_FOR_BLACKLIST] }, posting: { OR: [{ companyId: null }, { companyId: { not: companyId } }] } },
    select: { id: true, posting: { select: { companyName: true } } },
  });
  const branchIds = others.filter((a) => companyBlacklistKeys(a.posting.companyName).includes(key)).map((a) => a.id);
  if (branchIds.length) {
    await setStatusMany({ userId, id: { in: branchIds } }, "SKIPPED", "Company is blacklisted (country branch)");
  }
  const { company: _company, ...result } = row;
  return result;
}

export async function unblacklistCompany(userId: string, companyId: string) {
  await prisma.blacklisted.deleteMany({ where: { userId, companyId } });
}
