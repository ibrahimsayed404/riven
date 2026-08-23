-- GIST spatial indexes for geography columns (not expressible in Prisma schema)
CREATE INDEX user_location_gist        ON "users"   USING GIST (location);
CREATE INDEX vendor_home_location_gist ON "vendors" USING GIST ("homeLocation");
CREATE INDEX bazaar_location_gist      ON "bazaars" USING GIST (location);
CREATE INDEX event_location_gist       ON "events"  USING GIST (location);

-- CHECK constraint: rating scores must be 1–5
ALTER TABLE "ratings" ADD CONSTRAINT rating_score_range
  CHECK (score >= 1 AND score <= 5);