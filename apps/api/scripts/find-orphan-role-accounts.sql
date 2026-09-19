-- fix.js AUTH-02 (data half). Before the fix, POST /auth/register accepted
-- role: VENDOR | ORGANIZER and created a User with no Vendor / Organizer row.
-- Such accounts cannot use any /vendors/me or /organizers/me route. This
-- script only LISTS them; what to do is a per-account decision:
--   (a) contact the owner and create the missing profile row by hand, or
--   (b) soft-delete the account (UPDATE users SET "deletedAt" = now() WHERE id = ...)
--       — note the email stays reserved by the unique index either way.
-- Run: psql "$DATABASE_URL" -f apps/api/scripts/find-orphan-role-accounts.sql
SELECT u."id", u."email", u."role", u."createdAt"
FROM "public"."users" u
LEFT JOIN "public"."vendors"    v ON v."ownerId" = u."id"
LEFT JOIN "public"."organizers" o ON o."ownerId" = u."id"
WHERE u."deletedAt" IS NULL
  AND (
    (u."role" = 'VENDOR'    AND v."id" IS NULL) OR
    (u."role" = 'ORGANIZER' AND o."id" IS NULL)
  )
ORDER BY u."createdAt";
