-- Spending tracking: AI token usage, API services and payments, price list, search credits, budgets.
-- Only adds new types and tables; no existing data is changed.

-- CreateEnum
CREATE TYPE "AiAction" AS ENUM ('FRAUD_RATING', 'MATCH_RATING', 'RESUME_TAILORING', 'COVER_LETTER', 'FORM_ANSWERS', 'OTHER');

-- CreateEnum
CREATE TYPE "ApiCategory" AS ENUM ('AI', 'JOB_SEARCH', 'OTHER');

-- CreateEnum
CREATE TYPE "BillingPeriod" AS ENUM ('PER_REQUEST', 'PER_1000_REQUESTS', 'PER_MILLION_TOKENS', 'PAY_AS_YOU_GO', 'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY', 'ONE_TIME');

-- CreateTable
CREATE TABLE "ai_token_usage" (
    "id" BIGSERIAL NOT NULL,
    "userId" TEXT,
    "applicationId" TEXT,
    "requestId" TEXT,
    "action" "AiAction" NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'anthropic',
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL,
    "outputTokens" INTEGER NOT NULL,
    "cacheWriteTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
    "webSearchRequests" INTEGER NOT NULL DEFAULT 0,
    "estimatedCostUsd" DECIMAL(12,6),
    "priceId" TEXT,
    "fallbackUsed" BOOLEAN NOT NULL DEFAULT false,
    "stopReason" TEXT,
    "durationMs" INTEGER,
    "subject" TEXT,
    "details" JSONB,
    "usedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_token_usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_model_prices" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'anthropic',
    "model" TEXT NOT NULL,
    "inputPerMTok" DECIMAL(10,4) NOT NULL,
    "outputPerMTok" DECIMAL(10,4) NOT NULL,
    "cacheReadPerMTok" DECIMAL(10,4) NOT NULL,
    "cacheWritePerMTok" DECIMAL(10,4) NOT NULL,
    "webSearchPer1k" DECIMAL(10,4) NOT NULL DEFAULT 10,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_model_prices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_services" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" "ApiCategory" NOT NULL,
    "searchProvider" "SearchProvider",
    "planName" TEXT,
    "cost" DECIMAL(12,2),
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "billingPeriod" "BillingPeriod" NOT NULL,
    "includedUnits" INTEGER,
    "unitName" TEXT,
    "websiteUrl" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "api_services_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_payments" (
    "id" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "billingPeriod" "BillingPeriod" NOT NULL,
    "periodStart" DATE,
    "periodEnd" DATE,
    "datePaid" DATE,
    "invoiceRef" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "api_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "search_api_usage" (
    "id" BIGSERIAL NOT NULL,
    "userId" TEXT,
    "requestId" TEXT,
    "provider" "SearchProvider" NOT NULL,
    "credits" INTEGER NOT NULL,
    "resultCount" INTEGER,
    "statusCode" INTEGER,
    "usedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "search_api_usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "spending_budgets" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "serviceId" TEXT,
    "category" "ApiCategory",
    "monthlyLimitUsd" DECIMAL(12,2) NOT NULL,
    "alertAtPercent" INTEGER NOT NULL DEFAULT 80,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "spending_budgets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_token_usage_usedAt_idx" ON "ai_token_usage"("usedAt");

-- CreateIndex
CREATE INDEX "ai_token_usage_action_usedAt_idx" ON "ai_token_usage"("action", "usedAt");

-- CreateIndex
CREATE INDEX "ai_token_usage_model_usedAt_idx" ON "ai_token_usage"("model", "usedAt");

-- CreateIndex
CREATE INDEX "ai_token_usage_userId_usedAt_idx" ON "ai_token_usage"("userId", "usedAt");

-- CreateIndex
CREATE INDEX "ai_token_usage_requestId_idx" ON "ai_token_usage"("requestId");

-- CreateIndex
CREATE UNIQUE INDEX "ai_model_prices_model_effectiveFrom_key" ON "ai_model_prices"("model", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "api_services_name_key" ON "api_services"("name");

-- CreateIndex
CREATE INDEX "api_payments_serviceId_periodStart_idx" ON "api_payments"("serviceId", "periodStart");

-- CreateIndex
CREATE INDEX "api_payments_datePaid_idx" ON "api_payments"("datePaid");

-- CreateIndex
CREATE INDEX "search_api_usage_provider_usedAt_idx" ON "search_api_usage"("provider", "usedAt");

-- CreateIndex
CREATE INDEX "search_api_usage_usedAt_idx" ON "search_api_usage"("usedAt");

-- AddForeignKey
ALTER TABLE "ai_token_usage" ADD CONSTRAINT "ai_token_usage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_token_usage" ADD CONSTRAINT "ai_token_usage_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "applications"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_token_usage" ADD CONSTRAINT "ai_token_usage_priceId_fkey" FOREIGN KEY ("priceId") REFERENCES "ai_model_prices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_payments" ADD CONSTRAINT "api_payments_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "api_services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "search_api_usage" ADD CONSTRAINT "search_api_usage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "spending_budgets" ADD CONSTRAINT "spending_budgets_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "api_services"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ── Starting data (edit or delete freely) ─────────────────────────────

-- Claude list prices in USD per million tokens (cache write = 5-minute cache, 1.25x input).
-- Check https://platform.claude.com/docs/en/about-claude/pricing and add a new row when prices change.
INSERT INTO "ai_model_prices" ("id", "model", "inputPerMTok", "outputPerMTok", "cacheReadPerMTok", "cacheWritePerMTok", "webSearchPer1k", "effectiveFrom", "notes", "updatedAt") VALUES
  (gen_random_uuid()::text, 'claude-opus-5-5',   4.00, 20.00, 0.20, 5.00,  10, '2026-01-01', 'List price', CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'claude-sonnet-5-5', 2.00, 10.00, 0.20, 2.50,  10, '2026-01-01', 'List price', CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'claude-haiku-5-5',  0.10,  0.50, 0.01, 0.125, 10, '2026-01-01', 'List price for prompts up to 100K tokens; cache read assumed at 0.1x input - check the pricing page', CURRENT_TIMESTAMP);

-- The APIs this app calls. Fill in your plan, cost and included units.
INSERT INTO "api_services" ("id", "name", "category", "searchProvider", "billingPeriod", "unitName", "websiteUrl", "notes", "updatedAt") VALUES
  (gen_random_uuid()::text, 'Anthropic Claude API', 'AI', NULL, 'PAY_AS_YOU_GO', 'tokens', 'https://platform.claude.com/settings/billing', 'Usage is tracked per call in ai_token_usage', CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'JSearch (RapidAPI)', 'JOB_SEARCH', 'JSEARCH', 'MONTHLY', 'requests', 'https://rapidapi.com/letscrape-6bRBa3QguO5/api/jsearch/pricing', 'Fill in your plan, cost and included requests. Each page of results is one request.', CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'SerpApi', 'JOB_SEARCH', 'SERPAPI', 'MONTHLY', 'searches', 'https://serpapi.com/pricing', 'Fill in your plan, cost and included searches. Each page of results is one search.', CURRENT_TIMESTAMP);
