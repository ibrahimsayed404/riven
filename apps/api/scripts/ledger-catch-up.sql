-- Stock-ledger catch-up (specs/commerce/25 §10, S3 deployment).
-- Use ONLY when GET /health/maintenance reports LEDGER-DRIFT after a deploy, i.e.
-- stock changed while code without the ledger was still running (between
-- `prisma migrate deploy` and the new release). It appends ONE row per drifted
-- variant that brings the ledger to the counter; nothing is edited or deleted.
-- Review the SELECT first; run the INSERT once; then the condition clears.
--
--   psql "$DATABASE_URL" -f apps/api/scripts/ledger-catch-up.sql

-- 1. What would be corrected (variant, ledger sum, counter, difference):
SELECT v."id", COALESCE(l.total, 0) AS ledger, v."stockQuantity" AS stock, v."stockQuantity" - COALESCE(l.total, 0) AS difference
FROM "product_variants" v
LEFT JOIN (SELECT "variantId", SUM("quantityDelta") AS total FROM "inventory_movements" GROUP BY "variantId") l ON l."variantId" = v."id"
WHERE v."stockQuantity" <> COALESCE(l.total, 0);

-- 2. The catch-up rows (OPENING_BALANCE may carry any delta; before + delta = after holds):
INSERT INTO "inventory_movements" ("id", "variantId", "type", "quantityDelta", "quantityBefore", "quantityAfter", "source", "reason")
SELECT gen_random_uuid()::text, v."id", 'OPENING_BALANCE',
       v."stockQuantity" - COALESCE(l.total, 0), COALESCE(l.total, 0), v."stockQuantity",
       'migration', 'ledger catch-up after deploy (stock changed by pre-ledger code)'
FROM "product_variants" v
LEFT JOIN (SELECT "variantId", SUM("quantityDelta") AS total FROM "inventory_movements" GROUP BY "variantId") l ON l."variantId" = v."id"
WHERE v."stockQuantity" <> COALESCE(l.total, 0) AND COALESCE(l.total, 0) >= 0;
