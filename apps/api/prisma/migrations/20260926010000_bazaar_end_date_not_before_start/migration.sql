-- A bazaar's endDate is optional but never before its startDate. The completion
-- job and discovery's upcomingOnly read endDate < now as "over", so a backwards
-- range would end a bazaar before it opens. BazaarsService checks this too; the
-- constraint closes the race between two partial PATCHes (one moving startDate,
-- one moving endDate) that each pass the service check against the old row.
-- Prisma cannot model CHECK constraints and does not diff them, so, like the GIST
-- indexes, this lives only in migration SQL.
ALTER TABLE "bazaars"
  ADD CONSTRAINT "bazaars_end_date_not_before_start"
  CHECK ("endDate" IS NULL OR "endDate" >= "startDate");
