-- Per-user company blacklist, jobs.postedAt replaces jobs.datePosted, and jobs
-- survive when their user or company is deleted.
-- Written by hand so existing data is carried over before old columns are dropped.

-- ── 1. New "blacklisted" table ───────────────────────────────────────────
CREATE TABLE "blacklisted" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "blacklisted_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "blacklisted_userId_companyId_key" ON "blacklisted"("userId", "companyId");
CREATE INDEX "blacklisted_companyId_idx" ON "blacklisted"("companyId");

-- Deleting a user or a company deletes its blacklist rows.
ALTER TABLE "blacklisted" ADD CONSTRAINT "blacklisted_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "blacklisted" ADD CONSTRAINT "blacklisted_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Carry over the old global flag: a company that was blacklisted stays
-- blacklisted for every existing user.
INSERT INTO "blacklisted" ("id", "userId", "companyId", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, u."id", c."id", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "companies" c
CROSS JOIN "users" u
WHERE c."blacklisted" = true;

ALTER TABLE "companies" DROP COLUMN "blacklisted";

-- ── 2. Jobs keep the company name and survive user/company deletion ──────
ALTER TABLE "jobs" ADD COLUMN "companyName" TEXT;
UPDATE "jobs" j SET "companyName" = c."name" FROM "companies" c WHERE c."id" = j."companyId";
UPDATE "jobs" SET "companyName" = 'Unknown company' WHERE "companyName" IS NULL;
ALTER TABLE "jobs" ALTER COLUMN "companyName" SET NOT NULL;

ALTER TABLE "jobs" DROP CONSTRAINT "jobs_userId_fkey";
ALTER TABLE "jobs" DROP CONSTRAINT "jobs_companyId_fkey";
ALTER TABLE "jobs" ALTER COLUMN "userId" DROP NOT NULL;
ALTER TABLE "jobs" ALTER COLUMN "companyId" DROP NOT NULL;
-- Deleting a user or company sets these to NULL instead of deleting the job.
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── 3. jobs.datePosted removed (jobs.postedAt already holds the exact date) ─
ALTER TABLE "jobs" DROP COLUMN "datePosted";

-- The enum is now only a search filter, so OLDER and UNKNOWN are removed.
UPDATE "search_criteria" SET "datePosted" = 'PAST_MONTH' WHERE "datePosted" IN ('OLDER', 'UNKNOWN');
ALTER TABLE "search_criteria" ALTER COLUMN "datePosted" DROP DEFAULT;
CREATE TYPE "DatePostedRange_new" AS ENUM ('PAST_WEEK', 'PAST_2_WEEKS', 'PAST_MONTH');
ALTER TABLE "search_criteria" ALTER COLUMN "datePosted" TYPE "DatePostedRange_new"
    USING ("datePosted"::text::"DatePostedRange_new");
DROP TYPE "DatePostedRange";
ALTER TYPE "DatePostedRange_new" RENAME TO "DatePostedRange";
ALTER TABLE "search_criteria" ALTER COLUMN "datePosted" SET DEFAULT 'PAST_WEEK';
