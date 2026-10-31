-- Barcode registry (riven-barcode-inventory-plan §E, §F.3; phase B1). Additive only.

CREATE TYPE "public"."BarcodeScope" AS ENUM ('INTERNAL', 'VENDOR');
CREATE TYPE "public"."BarcodeStatus" AS ENUM ('PENDING_APPROVAL', 'ACTIVE', 'INACTIVE', 'REJECTED');
CREATE TYPE "public"."PackagingType" AS ENUM ('UNIT', 'PACK', 'CASE');

ALTER TYPE "public"."AdminAction" ADD VALUE 'BARCODE_CREATED';
ALTER TYPE "public"."AdminAction" ADD VALUE 'BARCODE_APPROVED';
ALTER TYPE "public"."AdminAction" ADD VALUE 'BARCODE_REJECTED';
ALTER TYPE "public"."AdminAction" ADD VALUE 'BARCODE_ACTIVATED';
ALTER TYPE "public"."AdminAction" ADD VALUE 'BARCODE_DEACTIVATED';
ALTER TYPE "public"."AdminAction" ADD VALUE 'BARCODE_UPDATED';
ALTER TYPE "public"."AdminTargetType" ADD VALUE 'BARCODE';

CREATE TABLE "public"."barcodes" (
    "id" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "scope" "public"."BarcodeScope" NOT NULL,
    "vendorId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "packagingType" "public"."PackagingType" NOT NULL,
    "unitsPerPackage" INTEGER NOT NULL,
    "status" "public"."BarcodeStatus" NOT NULL,
    "configVersion" INTEGER NOT NULL DEFAULT 1,
    "source" TEXT NOT NULL,
    "proposedById" TEXT,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "barcodes_pkey" PRIMARY KEY ("id"),
    -- UNIT is exactly one base unit; PACK / CASE hold at least two
    CONSTRAINT "barcodes_units_check" CHECK (("packagingType" = 'UNIT') = ("unitsPerPackage" = 1) AND "unitsPerPackage" >= 1),
    -- the RVN namespace belongs to Riven-generated values only (plan §F.3)
    CONSTRAINT "barcodes_namespace_check" CHECK (("scope" = 'INTERNAL') = (upper("value") LIKE 'RVN%')),
    CONSTRAINT "barcodes_value_length_check" CHECK (char_length("value") BETWEEN 1 AND 128),
    CONSTRAINT "barcodes_config_version_check" CHECK ("configVersion" >= 1)
);

CREATE TABLE "public"."barcode_events" (
    "id" TEXT NOT NULL,
    "barcodeId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "actorRole" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "barcode_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "barcodes_value_idx" ON "public"."barcodes"("value");
CREATE INDEX "barcodes_variantId_idx" ON "public"."barcodes"("variantId");
CREATE INDEX "barcodes_vendorId_status_idx" ON "public"."barcodes"("vendorId", "status");
CREATE INDEX "barcode_events_barcodeId_createdAt_idx" ON "public"."barcode_events"("barcodeId", "createdAt");

-- Uniqueness (plan §F.3): rejected / withdrawn proposals never block a value;
-- INACTIVE still does (a value is not re-assignable — P-4 default, pending Ibrahim).
CREATE UNIQUE INDEX "barcodes_internal_value_key" ON "public"."barcodes"("value")
  WHERE "scope" = 'INTERNAL' AND "status" <> 'REJECTED';
CREATE UNIQUE INDEX "barcodes_vendor_value_key" ON "public"."barcodes"("vendorId", "value")
  WHERE "scope" = 'VENDOR' AND "status" <> 'REJECTED';

ALTER TABLE "public"."barcodes" ADD CONSTRAINT "barcodes_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "public"."vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "public"."barcodes" ADD CONSTRAINT "barcodes_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "public"."product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "public"."barcode_events" ADD CONSTRAINT "barcode_events_barcodeId_fkey" FOREIGN KEY ("barcodeId") REFERENCES "public"."barcodes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The mapping is immutable once the barcode leaves PENDING_APPROVAL (plan §F.3):
-- remapping = deactivate and register a new barcode.
CREATE OR REPLACE FUNCTION "public"."barcodes_mapping_guard"() RETURNS trigger AS $$
BEGIN
  IF OLD."status" <> 'PENDING_APPROVAL' AND (
       NEW."value" IS DISTINCT FROM OLD."value" OR NEW."scope" IS DISTINCT FROM OLD."scope"
    OR NEW."vendorId" IS DISTINCT FROM OLD."vendorId" OR NEW."variantId" IS DISTINCT FROM OLD."variantId") THEN
    RAISE EXCEPTION 'barcode mapping is immutable once decided (barcode %)', OLD."id" USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER "barcodes_mapping_immutable" BEFORE UPDATE ON "public"."barcodes"
  FOR EACH ROW EXECUTE FUNCTION "public"."barcodes_mapping_guard"();
CREATE TRIGGER "barcodes_no_delete" BEFORE DELETE ON "public"."barcodes"
  FOR EACH ROW EXECUTE FUNCTION "public"."outbox_append_only_guard"();

-- History is append-only (reuses the generic guard of the outbox migration).
CREATE TRIGGER "barcode_events_no_update" BEFORE UPDATE ON "public"."barcode_events"
  FOR EACH ROW EXECUTE FUNCTION "public"."outbox_append_only_guard"();
CREATE TRIGGER "barcode_events_no_delete" BEFORE DELETE ON "public"."barcode_events"
  FOR EACH ROW EXECUTE FUNCTION "public"."outbox_append_only_guard"();
