-- Judges' review round 1 (specs/commerce/25 §10): store the Paymob payment page URL on the
-- order group, and record a signed charge that matches no order as an UNMATCHED_PAYMENT
-- exception (no order group). Additive.

-- AlterEnum
ALTER TYPE "public"."PaymentExceptionType" ADD VALUE 'UNMATCHED_PAYMENT';

-- AlterTable
ALTER TABLE "public"."order_groups" ADD COLUMN     "paymobClientUrl" TEXT;

-- AlterTable
ALTER TABLE "public"."payment_exceptions" ALTER COLUMN "orderGroupId" DROP NOT NULL;


-- An exception names its order group, except an unmatched charge (there is none).
-- Compared as text: the new enum value cannot be used in the transaction that adds it.
ALTER TABLE "public"."payment_exceptions"
  ADD CONSTRAINT "payment_exceptions_group_required" CHECK ("orderGroupId" IS NOT NULL OR "type"::text = 'UNMATCHED_PAYMENT');
