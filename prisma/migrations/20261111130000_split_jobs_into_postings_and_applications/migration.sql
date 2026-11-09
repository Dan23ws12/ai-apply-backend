-- Split "jobs" into shared "job_postings" (+ "job_apply_options") and per-user "applications"
-- so every table is in third normal form. Data is copied, not dropped:
--   * one job_postings row per externalId (the copy with a fraud rating wins, then the newest)
--   * every apply link from jobs.applyOptions, plus each job's applicationLink, becomes a job_apply_options row
--   * every jobs row becomes an applications row WITH THE SAME id, so /api/jobs/:id,
--     application_files and the Excel log's Job ID keep working
--   * each application gets one status event recording its status at the time of the split

-- ── New tables (same DDL Prisma generates) ──
CREATE TABLE "job_postings" (
    "id" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "provider" "SearchProvider" NOT NULL,
    "companyId" TEXT,
    "companyName" TEXT NOT NULL,
    "positionName" TEXT NOT NULL,
    "description" TEXT,
    "location" TEXT,
    "jobType" "JobType" NOT NULL DEFAULT 'UNKNOWN',
    "locationType" "JobLocationType" NOT NULL DEFAULT 'UNKNOWN',
    "salaryMin" INTEGER,
    "salaryMax" INTEGER,
    "salaryCurrency" TEXT,
    "salaryPeriod" TEXT,
    "postedAt" TIMESTAMP(3),
    "fraudRating" INTEGER,
    "fraudReason" TEXT,
    "fraudDetails" JSONB,
    "fraudEvaluatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_postings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "job_apply_options" (
    "id" TEXT NOT NULL,
    "postingId" TEXT NOT NULL,
    "publisher" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "isDirect" BOOLEAN NOT NULL DEFAULT false,
    "website" "SearchWebsite" NOT NULL DEFAULT 'OTHER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_apply_options_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "applications" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "postingId" TEXT NOT NULL,
    "searchCriteriaId" TEXT,
    "applyOptionId" TEXT NOT NULL,
    "searchWebsite" "SearchWebsite" NOT NULL DEFAULT 'OTHER',
    "matchRating" INTEGER,
    "matchReason" TEXT,
    "matchDetails" JSONB,
    "applicationStatus" "ApplicationStatus" NOT NULL DEFAULT 'FOUND',
    "statusMessage" TEXT,
    "applicationDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "applications_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "application_status_events" (
    "id" BIGSERIAL NOT NULL,
    "applicationId" TEXT NOT NULL,
    "fromStatus" "ApplicationStatus",
    "toStatus" "ApplicationStatus" NOT NULL,
    "message" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "application_status_events_pkey" PRIMARY KEY ("id")
);

-- ── Copy data ──

-- One posting per externalId: prefer a copy that already has a fraud rating, then the newest.
INSERT INTO "job_postings" (
    "id", "externalId", "provider", "companyId", "companyName", "positionName", "description",
    "location", "jobType", "locationType", "salaryMin", "salaryMax", "salaryCurrency", "salaryPeriod",
    "postedAt", "fraudRating", "fraudReason", "fraudDetails", "fraudEvaluatedAt", "createdAt", "updatedAt"
)
SELECT DISTINCT ON (j."externalId")
    gen_random_uuid()::text, j."externalId", j."provider", j."companyId", j."companyName", j."positionName",
    j."description", j."location", j."jobType", j."locationType", j."salaryMin", j."salaryMax",
    j."salaryCurrency", j."salaryPeriod", j."postedAt", j."fraudRating", j."fraudReason", j."fraudDetails",
    CASE WHEN j."fraudRating" IS NOT NULL THEN j."updatedAt" END,
    (SELECT MIN(j2."createdAt") FROM "jobs" j2 WHERE j2."externalId" = j."externalId"),
    j."updatedAt"
FROM "jobs" j
ORDER BY j."externalId", (j."fraudRating" IS NULL), j."updatedAt" DESC;

-- Every apply link listed in jobs.applyOptions (JSON list of {publisher, url, isDirect, website}).
INSERT INTO "job_apply_options" ("id", "postingId", "publisher", "url", "isDirect", "website", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, x."postingId", x."publisher", x."url", x."isDirect", x."website", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM (
    SELECT DISTINCT ON (p."id", o->>'url')
        p."id" AS "postingId",
        COALESCE(o->>'publisher', '') AS "publisher",
        o->>'url' AS "url",
        COALESCE((o->>'isDirect')::boolean, false) AS "isDirect",
        CASE WHEN o->>'website' IN ('LINKEDIN', 'GLASSDOOR', 'INDEED', 'COMPANY_SITE', 'OTHER')
             THEN (o->>'website')::"SearchWebsite" ELSE 'OTHER'::"SearchWebsite" END AS "website"
    FROM "jobs" j
    JOIN "job_postings" p ON p."externalId" = j."externalId"
    CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(j."applyOptions") = 'array' THEN j."applyOptions" ELSE '[]'::jsonb END
    ) AS o
    WHERE COALESCE(o->>'url', '') <> ''
    ORDER BY p."id", o->>'url'
) x;

-- Each job's chosen applicationLink, when it was not in its applyOptions list.
INSERT INTO "job_apply_options" ("id", "postingId", "publisher", "url", "isDirect", "website", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, x."postingId", '', x."url", false,
       CASE WHEN x."url" ILIKE '%linkedin%' THEN 'LINKEDIN'::"SearchWebsite"
            WHEN x."url" ILIKE '%glassdoor%' THEN 'GLASSDOOR'::"SearchWebsite"
            WHEN x."url" ILIKE '%indeed%' THEN 'INDEED'::"SearchWebsite"
            ELSE 'OTHER'::"SearchWebsite" END,
       CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM (
    SELECT DISTINCT p."id" AS "postingId", j."applicationLink" AS "url"
    FROM "jobs" j
    JOIN "job_postings" p ON p."externalId" = j."externalId"
    WHERE NOT EXISTS (
        SELECT 1 FROM "job_apply_options" a WHERE a."postingId" = p."id" AND a."url" = j."applicationLink"
    )
) x;

-- Every job becomes an application with the same id.
INSERT INTO "applications" (
    "id", "userId", "postingId", "searchCriteriaId", "applyOptionId", "searchWebsite", "matchRating",
    "matchReason", "matchDetails", "applicationStatus", "statusMessage", "applicationDate", "createdAt", "updatedAt"
)
SELECT
    j."id", j."userId", p."id", j."searchCriteriaId", a."id", j."searchWebsite", j."matchRating",
    j."matchReason", j."matchDetails", j."applicationStatus", j."statusMessage", j."applicationDate",
    j."createdAt", j."updatedAt"
FROM "jobs" j
JOIN "job_postings" p ON p."externalId" = j."externalId"
JOIN "job_apply_options" a ON a."postingId" = p."id" AND a."url" = j."applicationLink";

-- Starting point of each application's status history.
INSERT INTO "application_status_events" ("applicationId", "fromStatus", "toStatus", "message", "createdAt")
SELECT a."id", NULL, a."applicationStatus", 'Status when the jobs table was split',
       CASE WHEN a."applicationStatus" = 'APPLIED' AND a."applicationDate" IS NOT NULL
            THEN a."applicationDate" ELSE a."updatedAt" END
FROM "applications" a;

-- application_files.jobId -> applicationId (same ids, so the values carry over).
ALTER TABLE "application_files" DROP CONSTRAINT "application_files_jobId_fkey";
DROP INDEX "application_files_jobId_key";
ALTER TABLE "application_files" RENAME COLUMN "jobId" TO "applicationId";

-- ── Remove the old table ──
DROP TABLE "jobs";

-- ── Indexes and foreign keys (same names Prisma generates) ──
CREATE UNIQUE INDEX "job_postings_externalId_key" ON "job_postings"("externalId");
CREATE INDEX "job_postings_companyId_idx" ON "job_postings"("companyId");
CREATE UNIQUE INDEX "job_apply_options_postingId_url_key" ON "job_apply_options"("postingId", "url");
CREATE INDEX "applications_userId_applicationStatus_idx" ON "applications"("userId", "applicationStatus");
CREATE INDEX "applications_postingId_idx" ON "applications"("postingId");
CREATE INDEX "applications_searchCriteriaId_idx" ON "applications"("searchCriteriaId");
CREATE UNIQUE INDEX "applications_userId_postingId_key" ON "applications"("userId", "postingId");
CREATE INDEX "application_status_events_applicationId_createdAt_idx" ON "application_status_events"("applicationId", "createdAt");
CREATE UNIQUE INDEX "application_files_applicationId_key" ON "application_files"("applicationId");

ALTER TABLE "job_postings" ADD CONSTRAINT "job_postings_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "job_apply_options" ADD CONSTRAINT "job_apply_options_postingId_fkey" FOREIGN KEY ("postingId") REFERENCES "job_postings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "applications" ADD CONSTRAINT "applications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "applications" ADD CONSTRAINT "applications_postingId_fkey" FOREIGN KEY ("postingId") REFERENCES "job_postings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "applications" ADD CONSTRAINT "applications_searchCriteriaId_fkey" FOREIGN KEY ("searchCriteriaId") REFERENCES "search_criteria"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "applications" ADD CONSTRAINT "applications_applyOptionId_fkey" FOREIGN KEY ("applyOptionId") REFERENCES "job_apply_options"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "application_status_events" ADD CONSTRAINT "application_status_events_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "application_files" ADD CONSTRAINT "application_files_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;
