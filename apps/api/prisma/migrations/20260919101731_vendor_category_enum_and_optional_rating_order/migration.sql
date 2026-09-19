-- fix.js SCHEMA-02: Vendor.category from free text to an enum.
-- Prisma's own diff would DROP and re-ADD the column (losing every value); this
-- converts in place. Existing strings are mapped case-insensitively; anything
-- unrecognised becomes OTHER rather than failing the migration.
CREATE TYPE "public"."VendorCategory" AS ENUM ('FASHION', 'FOOD', 'HOME_CRAFTS', 'BEAUTY', 'ACCESSORIES', 'KIDS', 'ART', 'OTHER');

ALTER TABLE "public"."vendors"
  ALTER COLUMN "category" DROP DEFAULT,
  ALTER COLUMN "category" TYPE "public"."VendorCategory"
    USING (
      CASE lower(trim("category"))
        WHEN 'fashion' THEN 'FASHION'
        WHEN 'clothing' THEN 'FASHION'
        WHEN 'food' THEN 'FOOD'
        WHEN 'home_crafts' THEN 'HOME_CRAFTS'
        WHEN 'home & crafts' THEN 'HOME_CRAFTS'
        WHEN 'crafts' THEN 'HOME_CRAFTS'
        WHEN 'home' THEN 'HOME_CRAFTS'
        WHEN 'beauty' THEN 'BEAUTY'
        WHEN 'accessories' THEN 'ACCESSORIES'
        WHEN 'kids' THEN 'KIDS'
        WHEN 'art' THEN 'ART'
        ELSE 'OTHER'
      END
    )::"public"."VendorCategory",
  ALTER COLUMN "category" SET DEFAULT 'OTHER';

-- The existing vendors_category_idx survives an in-place type change.

-- fix.js SPEC-03: bazaar ratings carry no order; vendor/product ratings still must
-- (enforced in SocialService). The FK to orders is unchanged.
ALTER TABLE "public"."ratings" ALTER COLUMN "orderId" DROP NOT NULL;
