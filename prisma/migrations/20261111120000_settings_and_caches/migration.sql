-- Per-user settings, search result cache, fraud/match evaluation cache.

-- CreateEnum
CREATE TYPE "EvaluationKind" AS ENUM ('FRAUD', 'MATCH');

-- search_criteria.maxResults becomes an optional override of user_settings.jobsPerSearch.
-- 20 was the old column default, so rows still on it now follow the user's setting.
ALTER TABLE "search_criteria" ALTER COLUMN "maxResults" DROP NOT NULL;
ALTER TABLE "search_criteria" ALTER COLUMN "maxResults" DROP DEFAULT;
UPDATE "search_criteria" SET "maxResults" = NULL WHERE "maxResults" = 20;

-- CreateTable
CREATE TABLE "user_settings" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "jobsPerSearch" INTEGER NOT NULL DEFAULT 10,
    "pagesPerSearch" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_settings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "user_settings_jobsPerSearch_check" CHECK ("jobsPerSearch" BETWEEN 1 AND 50),
    CONSTRAINT "user_settings_pagesPerSearch_check" CHECK ("pagesPerSearch" BETWEEN 1 AND 5)
);

-- CreateTable
CREATE TABLE "search_cache" (
    "id" TEXT NOT NULL,
    "cacheKey" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "provider" "SearchProvider" NOT NULL,
    "jobs" JSONB NOT NULL,
    "pagesFetched" INTEGER NOT NULL DEFAULT 0,
    "nextPageToken" TEXT,
    "exhausted" BOOLEAN NOT NULL DEFAULT false,
    "apiCalls" INTEGER NOT NULL DEFAULT 0,
    "hitCount" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "search_cache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evaluation_cache" (
    "id" TEXT NOT NULL,
    "kind" "EvaluationKind" NOT NULL,
    "cacheKey" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "hitCount" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "evaluation_cache_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_settings_userId_key" ON "user_settings"("userId");
CREATE UNIQUE INDEX "search_cache_cacheKey_key" ON "search_cache"("cacheKey");
CREATE INDEX "search_cache_expiresAt_idx" ON "search_cache"("expiresAt");
CREATE UNIQUE INDEX "evaluation_cache_kind_cacheKey_key" ON "evaluation_cache"("kind", "cacheKey");
CREATE INDEX "evaluation_cache_expiresAt_idx" ON "evaluation_cache"("expiresAt");

-- AddForeignKey
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
