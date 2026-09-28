-- Admin pass 2 (specs/admin-module-spec2.md A8): audit values for category management.
-- Enum-only; no tables, columns or indexes touched.
ALTER TYPE "public"."AdminAction" ADD VALUE 'CATEGORY_CREATED';
ALTER TYPE "public"."AdminAction" ADD VALUE 'CATEGORY_UPDATED';

ALTER TYPE "public"."AdminTargetType" ADD VALUE 'CATEGORY';
