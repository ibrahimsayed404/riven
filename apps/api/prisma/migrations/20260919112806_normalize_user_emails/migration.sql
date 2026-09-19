-- fix.js AUTH-03 (data half). The service now stores and looks up lower(trim(email));
-- rows written before that would never match a login again. Two accounts that
-- differ only by case cannot both survive the unique index, so the migration
-- refuses to guess: it stops and names them for a human to merge first.
DO $$
DECLARE
  dupes text;
BEGIN
  SELECT string_agg(lower(trim("email")) || ' (' || cnt || ' accounts)', ', ')
    INTO dupes
    FROM (
      SELECT lower(trim("email")) AS e, count(*) AS cnt
      FROM "public"."users"
      GROUP BY lower(trim("email"))
      HAVING count(*) > 1
    ) d;

  IF dupes IS NOT NULL THEN
    RAISE EXCEPTION 'normalize_user_emails: emails that differ only by case/whitespace must be merged before this migration can run: %', dupes;
  END IF;
END $$;

UPDATE "public"."users"
SET "email" = lower(trim("email"))
WHERE "email" <> lower(trim("email"));
