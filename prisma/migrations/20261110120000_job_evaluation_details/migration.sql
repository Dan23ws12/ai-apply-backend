-- Separate fraud and match evaluation details (both optional).
ALTER TABLE "jobs" ADD COLUMN "fraudDetails" JSONB;
ALTER TABLE "jobs" ADD COLUMN "matchDetails" JSONB;
