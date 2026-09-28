-- Product approval removed by product decision (Ibrahim, relayed 2026-09-27):
-- a vendor's product is now publicly visible as soon as it exists (subject to
-- isActive / vendor.verified / deletedAt, same as before). Vendor and
-- Organizer moderation never used this enum (they use verified + a plain
-- String? rejectionReason), so ApprovalStatus is now unused and dropped too.
ALTER TABLE "products" DROP COLUMN "approvalStatus",
DROP COLUMN "rejectionReason";

DROP TYPE "ApprovalStatus";
