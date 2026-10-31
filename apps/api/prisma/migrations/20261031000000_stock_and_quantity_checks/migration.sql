-- specs/commerce/25 slice S2 (approved by Youssef 2026-10-31): the database, not
-- only the checkout code, refuses negative stock and non-positive quantities.
-- Prisma cannot model CHECK constraints and does not diff them, so they live
-- here only (like the rating and bazaar-date checks).
--
-- Pre-check before deploying to any database with real data — each must return 0,
-- or this migration fails and nothing is applied:
--   SELECT count(*) FROM "product_variants" WHERE "stockQuantity" < 0;
--   SELECT count(*) FROM "cart_items"       WHERE "quantity" <= 0;
--   SELECT count(*) FROM "order_items"      WHERE "quantity" <= 0;

ALTER TABLE "product_variants"
  ADD CONSTRAINT "product_variants_stock_quantity_non_negative" CHECK ("stockQuantity" >= 0);

ALTER TABLE "cart_items"
  ADD CONSTRAINT "cart_items_quantity_positive" CHECK ("quantity" > 0);

ALTER TABLE "order_items"
  ADD CONSTRAINT "order_items_quantity_positive" CHECK ("quantity" > 0);
