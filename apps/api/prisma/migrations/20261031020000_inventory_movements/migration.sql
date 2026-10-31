-- specs/commerce/25 slice S3 (TD-08 approved by Youssef 2026-10-31): every change
-- of product_variants.stockQuantity becomes one append-only ledger row, written
-- in the same transaction as the change. Additive; existing stock is preserved
-- as an OPENING_BALANCE row per variant (backfill at the end).

-- CreateEnum
CREATE TYPE "public"."InventoryMovementType" AS ENUM ('OPENING_BALANCE', 'RESERVE', 'RELEASE', 'VENDOR_ADJUSTMENT');

-- CreateTable
CREATE TABLE "public"."inventory_movements" (
    "id" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "type" "public"."InventoryMovementType" NOT NULL,
    "quantityDelta" INTEGER NOT NULL,
    "quantityBefore" INTEGER NOT NULL,
    "quantityAfter" INTEGER NOT NULL,
    "orderGroupId" TEXT,
    "actorUserId" TEXT,
    "source" VARCHAR(32) NOT NULL,
    "reason" VARCHAR(500),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_movements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "inventory_movements_variantId_createdAt_idx" ON "public"."inventory_movements"("variantId", "createdAt");

-- CreateIndex
CREATE INDEX "inventory_movements_orderGroupId_idx" ON "public"."inventory_movements"("orderGroupId");

-- AddForeignKey
ALTER TABLE "public"."inventory_movements" ADD CONSTRAINT "inventory_movements_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "public"."product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."inventory_movements" ADD CONSTRAINT "inventory_movements_orderGroupId_fkey" FOREIGN KEY ("orderGroupId") REFERENCES "public"."order_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."inventory_movements" ADD CONSTRAINT "inventory_movements_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Hand-written rules (Prisma cannot model CHECKs or triggers)
-- ---------------------------------------------------------------------------

ALTER TABLE "public"."inventory_movements"
  ADD CONSTRAINT "inventory_movements_arithmetic" CHECK ("quantityAfter" = "quantityBefore" + "quantityDelta"),
  ADD CONSTRAINT "inventory_movements_after_non_negative" CHECK ("quantityBefore" >= 0 AND "quantityAfter" >= 0),
  ADD CONSTRAINT "inventory_movements_delta_non_zero" CHECK ("quantityDelta" <> 0 OR "type" = 'OPENING_BALANCE'),
  ADD CONSTRAINT "inventory_movements_direction" CHECK (
    ("type" = 'RESERVE' AND "quantityDelta" < 0)
    OR ("type" = 'RELEASE' AND "quantityDelta" > 0)
    OR "type" IN ('OPENING_BALANCE', 'VENDOR_ADJUSTMENT')
  ),
  ADD CONSTRAINT "inventory_movements_order_link" CHECK ("type" NOT IN ('RESERVE', 'RELEASE') OR "orderGroupId" IS NOT NULL);

CREATE OR REPLACE FUNCTION "public"."inventory_movements_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'inventory_movements is append-only (% refused)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "inventory_movements_append_only"
  BEFORE UPDATE OR DELETE ON "public"."inventory_movements"
  FOR EACH ROW EXECUTE FUNCTION "public"."inventory_movements_append_only"();

-- Backfill: the counter as it is now, so SUM(quantityDelta) per variant equals
-- stockQuantity from the first row on (soft-deleted variants included).
INSERT INTO "public"."inventory_movements" ("id", "variantId", "type", "quantityDelta", "quantityBefore", "quantityAfter", "source", "reason")
SELECT gen_random_uuid()::text, v."id", 'OPENING_BALANCE', v."stockQuantity", 0, v."stockQuantity", 'migration', 'stock when the ledger started'
FROM "public"."product_variants" v;
