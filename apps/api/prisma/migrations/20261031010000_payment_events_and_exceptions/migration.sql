-- specs/commerce/25 slice S1 (approved by Youssef 2026-10-31): every signed
-- Paymob callback is stored before anything is applied, and charges that must
-- not be applied normally (double, late, wrong amount, wrong currency) become
-- payment_exceptions rows instead of log lines. Additive only: no existing
-- table, column or row changes.


-- CreateEnum
CREATE TYPE "public"."PaymentProviderEventKind" AS ENUM ('PAYMENT', 'DECLINED', 'PENDING', 'REFUND', 'VOID', 'OTHER');

-- CreateEnum
CREATE TYPE "public"."PaymentExceptionType" AS ENUM ('DOUBLE_PAYMENT', 'LATE_PAYMENT', 'AMOUNT_MISMATCH', 'CURRENCY_MISMATCH');

-- CreateEnum
CREATE TYPE "public"."PaymentExceptionStatus" AS ENUM ('OPEN', 'RESOLVED');

-- AlterEnum
ALTER TYPE "public"."AdminAction" ADD VALUE 'PAYMENT_EXCEPTION_RESOLVED';

-- AlterEnum
ALTER TYPE "public"."AdminTargetType" ADD VALUE 'PAYMENT_EXCEPTION';

-- CreateTable
CREATE TABLE "public"."payment_provider_events" (
    "id" TEXT NOT NULL,
    "provider" VARCHAR(32) NOT NULL,
    "providerTransactionId" VARCHAR(64) NOT NULL,
    "kind" "public"."PaymentProviderEventKind" NOT NULL,
    "signedOrderId" VARCHAR(64),
    "amountCents" INTEGER,
    "currency" VARCHAR(8),
    "payload" JSONB NOT NULL,
    "outcome" VARCHAR(32),
    "handler" VARCHAR(64),
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "payment_provider_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."payment_exceptions" (
    "id" TEXT NOT NULL,
    "type" "public"."PaymentExceptionType" NOT NULL,
    "status" "public"."PaymentExceptionStatus" NOT NULL DEFAULT 'OPEN',
    "orderGroupId" TEXT NOT NULL,
    "provider" VARCHAR(32) NOT NULL,
    "providerTransactionId" VARCHAR(64) NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" VARCHAR(8),
    "expectedAmountCents" INTEGER,
    "detail" VARCHAR(1000) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "resolutionNote" VARCHAR(1000),

    CONSTRAINT "payment_exceptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payment_provider_events_receivedAt_idx" ON "public"."payment_provider_events"("receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "payment_provider_events_provider_providerTransactionId_kind_key" ON "public"."payment_provider_events"("provider", "providerTransactionId", "kind");

-- CreateIndex
CREATE INDEX "payment_exceptions_status_createdAt_idx" ON "public"."payment_exceptions"("status", "createdAt");

-- CreateIndex
CREATE INDEX "payment_exceptions_orderGroupId_idx" ON "public"."payment_exceptions"("orderGroupId");

-- CreateIndex
CREATE UNIQUE INDEX "payment_exceptions_type_provider_providerTransactionId_key" ON "public"."payment_exceptions"("type", "provider", "providerTransactionId");

-- AddForeignKey
ALTER TABLE "public"."payment_exceptions" ADD CONSTRAINT "payment_exceptions_orderGroupId_fkey" FOREIGN KEY ("orderGroupId") REFERENCES "public"."order_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."payment_exceptions" ADD CONSTRAINT "payment_exceptions_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Hand-written rules (Prisma cannot model CHECKs or triggers and does not diff them)
-- ---------------------------------------------------------------------------

ALTER TABLE "public"."payment_provider_events"
  ADD CONSTRAINT "payment_provider_events_amount_non_negative" CHECK ("amountCents" IS NULL OR "amountCents" >= 0);

ALTER TABLE "public"."payment_exceptions"
  ADD CONSTRAINT "payment_exceptions_amount_non_negative" CHECK ("amountCents" >= 0 AND ("expectedAmountCents" IS NULL OR "expectedAmountCents" >= 0)),
  ADD CONSTRAINT "payment_exceptions_resolution_consistent" CHECK (
    ("status" = 'OPEN' AND "resolvedAt" IS NULL AND "resolvedById" IS NULL AND "resolutionNote" IS NULL)
    OR ("status" = 'RESOLVED' AND "resolvedAt" IS NOT NULL AND "resolvedById" IS NOT NULL AND "resolutionNote" IS NOT NULL)
  );

-- Provider events are evidence: never deleted; only the processing columns change.
CREATE OR REPLACE FUNCTION "public"."payment_provider_events_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payment_provider_events is append-only (delete refused)';
  END IF;
  IF NEW."provider" IS DISTINCT FROM OLD."provider"
     OR NEW."providerTransactionId" IS DISTINCT FROM OLD."providerTransactionId"
     OR NEW."kind" IS DISTINCT FROM OLD."kind"
     OR NEW."signedOrderId" IS DISTINCT FROM OLD."signedOrderId"
     OR NEW."amountCents" IS DISTINCT FROM OLD."amountCents"
     OR NEW."currency" IS DISTINCT FROM OLD."currency"
     OR NEW."payload" IS DISTINCT FROM OLD."payload"
     OR NEW."receivedAt" IS DISTINCT FROM OLD."receivedAt" THEN
    RAISE EXCEPTION 'payment_provider_events: only outcome, handler and processedAt may change';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "payment_provider_events_guard"
  BEFORE UPDATE OR DELETE ON "public"."payment_provider_events"
  FOR EACH ROW EXECUTE FUNCTION "public"."payment_provider_events_guard"();

-- Exceptions are a financial audit trail: never deleted; the facts never change;
-- status only moves OPEN -> RESOLVED.
CREATE OR REPLACE FUNCTION "public"."payment_exceptions_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payment_exceptions are never deleted';
  END IF;
  IF NEW."type" IS DISTINCT FROM OLD."type"
     OR NEW."orderGroupId" IS DISTINCT FROM OLD."orderGroupId"
     OR NEW."provider" IS DISTINCT FROM OLD."provider"
     OR NEW."providerTransactionId" IS DISTINCT FROM OLD."providerTransactionId"
     OR NEW."amountCents" IS DISTINCT FROM OLD."amountCents"
     OR NEW."currency" IS DISTINCT FROM OLD."currency"
     OR NEW."expectedAmountCents" IS DISTINCT FROM OLD."expectedAmountCents"
     OR NEW."detail" IS DISTINCT FROM OLD."detail"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'payment_exceptions: the recorded facts are immutable';
  END IF;
  IF OLD."status" = 'RESOLVED' AND (NEW."status" IS DISTINCT FROM OLD."status"
     OR NEW."resolvedAt" IS DISTINCT FROM OLD."resolvedAt"
     OR NEW."resolvedById" IS DISTINCT FROM OLD."resolvedById"
     OR NEW."resolutionNote" IS DISTINCT FROM OLD."resolutionNote") THEN
    RAISE EXCEPTION 'payment_exceptions: a resolved exception cannot change';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "payment_exceptions_guard"
  BEFORE UPDATE OR DELETE ON "public"."payment_exceptions"
  FOR EACH ROW EXECUTE FUNCTION "public"."payment_exceptions_guard"();
