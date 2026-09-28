-- Admin Part B (specs/admin-module-spec3.md): audit values for admin edits, deletes,
-- application decisions, order/bazaar cancels, booth-layout ops and search reindex.
-- Enum-only; no tables, columns or indexes touched.
ALTER TYPE "public"."AdminAction" ADD VALUE 'VENDOR_EDITED';
ALTER TYPE "public"."AdminAction" ADD VALUE 'PRODUCT_EDITED';
ALTER TYPE "public"."AdminAction" ADD VALUE 'PRODUCT_DELETED';
ALTER TYPE "public"."AdminAction" ADD VALUE 'CATEGORY_DELETED';
ALTER TYPE "public"."AdminAction" ADD VALUE 'RATING_DELETED';
ALTER TYPE "public"."AdminAction" ADD VALUE 'RATING_COMMENT_CLEARED';
ALTER TYPE "public"."AdminAction" ADD VALUE 'APPLICATION_ACCEPTED';
ALTER TYPE "public"."AdminAction" ADD VALUE 'APPLICATION_REJECTED';
ALTER TYPE "public"."AdminAction" ADD VALUE 'ORDER_CANCELLED';
ALTER TYPE "public"."AdminAction" ADD VALUE 'BAZAAR_CANCELLED';
ALTER TYPE "public"."AdminAction" ADD VALUE 'BOOTH_LAYOUT_CREATED';
ALTER TYPE "public"."AdminAction" ADD VALUE 'BOOTH_LAYOUT_UPDATED';
ALTER TYPE "public"."AdminAction" ADD VALUE 'BOOTH_CREATED';
ALTER TYPE "public"."AdminAction" ADD VALUE 'BOOTH_UPDATED';
ALTER TYPE "public"."AdminAction" ADD VALUE 'BOOTH_DELETED';
ALTER TYPE "public"."AdminAction" ADD VALUE 'BOOTH_ASSIGNED';
ALTER TYPE "public"."AdminAction" ADD VALUE 'BOOTH_UNASSIGNED';
ALTER TYPE "public"."AdminAction" ADD VALUE 'SEARCH_REINDEX_REQUESTED';

ALTER TYPE "public"."AdminTargetType" ADD VALUE 'RATING';
ALTER TYPE "public"."AdminTargetType" ADD VALUE 'APPLICATION';
ALTER TYPE "public"."AdminTargetType" ADD VALUE 'ORDER';
ALTER TYPE "public"."AdminTargetType" ADD VALUE 'BAZAAR';
ALTER TYPE "public"."AdminTargetType" ADD VALUE 'BOOTH';
ALTER TYPE "public"."AdminTargetType" ADD VALUE 'SEARCH_INDEX';
