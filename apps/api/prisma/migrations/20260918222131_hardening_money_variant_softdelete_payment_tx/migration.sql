-- fix.js SCHEMA-01: Postgres `money` is locale-dependent; move prices to numeric(12,2).
-- The USING casts are explicit for readability; money -> numeric is an assignment cast,
-- so no precision is lost at 2 dp.
ALTER TABLE "public"."products" ALTER COLUMN "basePrice" SET DATA TYPE DECIMAL(12,2) USING "basePrice"::numeric(12,2);

ALTER TABLE "public"."product_variants" ALTER COLUMN "priceOverride" SET DATA TYPE DECIMAL(12,2) USING "priceOverride"::numeric(12,2);

ALTER TABLE "public"."orders" ALTER COLUMN "subtotal" SET DATA TYPE DECIMAL(12,2) USING "subtotal"::numeric(12,2);

ALTER TABLE "public"."order_items" ALTER COLUMN "priceSnapshot" SET DATA TYPE DECIMAL(12,2) USING "priceSnapshot"::numeric(12,2);

-- fix.js LOGIC-03: variants are referenced by cart_items/order_items (RESTRICT) -> soft-delete.
ALTER TABLE "public"."product_variants" ADD COLUMN "deletedAt" TIMESTAMP(3);

CREATE INDEX "product_variants_productId_idx" ON "public"."product_variants"("productId");

-- fix.js PAY-01/PAY-02: record which Paymob transaction paid a group, exactly once.
ALTER TABLE "public"."order_groups" ADD COLUMN "paidAmountCents" INTEGER,
ADD COLUMN "paidAt" TIMESTAMP(3),
ADD COLUMN "paymobTransactionId" TEXT,
ADD COLUMN "paymobOrderId" TEXT;

CREATE UNIQUE INDEX "order_groups_paymobTransactionId_key" ON "public"."order_groups"("paymobTransactionId");

CREATE INDEX "order_groups_paymobIntentId_idx" ON "public"."order_groups"("paymobIntentId");

CREATE INDEX "order_groups_paymobOrderId_idx" ON "public"."order_groups"("paymobOrderId");

-- fix.js ARCH-03: every relation now states its onDelete in schema.prisma. The values match
-- what Prisma had already generated (RESTRICT for required, SET NULL for optional), so this
-- migration deliberately contains no constraint changes. GIST indexes untouched.
