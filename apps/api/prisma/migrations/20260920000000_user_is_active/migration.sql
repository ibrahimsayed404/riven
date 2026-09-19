-- Admin deactivation used to reuse "deletedAt", so a suspended shopper was
-- indistinguishable from one who deleted their own account and got the same
-- INVALID_CREDENTIALS at login. Suspension now lives in "isActive".
ALTER TABLE "users" ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true;

-- Rows that were deactivated by an admin (audit trail says so, and no later
-- reactivation) move to the new flag so they can be reactivated normally.
-- Everything else with "deletedAt" set is an owner deletion and stays deleted.
UPDATE "users" u
SET "isActive" = false, "deletedAt" = NULL
WHERE u."deletedAt" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM "admin_audit_logs" a
    WHERE a."targetType" = 'USER'
      AND a."action" = 'USER_DEACTIVATED'
      AND a."targetId" = u."id"
      AND a."createdAt" >= u."deletedAt" - INTERVAL '5 seconds'
      AND NOT EXISTS (
        SELECT 1 FROM "admin_audit_logs" r
        WHERE r."targetType" = 'USER'
          AND r."action" = 'USER_REACTIVATED'
          AND r."targetId" = u."id"
          AND r."createdAt" > a."createdAt"
      )
  );
