-- specs/commerce/25 slice S4 (TD-07 approved by Youssef 2026-10-31): optional Idempotency-Key on
-- POST /checkout. Additive; no existing table changes.

-- CreateEnum
CREATE TYPE "public"."IdempotencyStatus" AS ENUM ('IN_PROGRESS', 'COMPLETED');

-- CreateTable
CREATE TABLE "public"."idempotency_keys" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "scope" VARCHAR(32) NOT NULL,
    "key" VARCHAR(128) NOT NULL,
    "status" "public"."IdempotencyStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "lockedUntil" TIMESTAMP(3) NOT NULL,
    "orderGroupId" TEXT,
    "responseStatus" INTEGER,
    "responseBody" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_keys_orderGroupId_key" ON "public"."idempotency_keys"("orderGroupId");

-- CreateIndex
CREATE INDEX "idempotency_keys_expiresAt_idx" ON "public"."idempotency_keys"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_keys_userId_scope_key_key" ON "public"."idempotency_keys"("userId", "scope", "key");

-- AddForeignKey
ALTER TABLE "public"."idempotency_keys" ADD CONSTRAINT "idempotency_keys_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."idempotency_keys" ADD CONSTRAINT "idempotency_keys_orderGroupId_fkey" FOREIGN KEY ("orderGroupId") REFERENCES "public"."order_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "public"."idempotency_keys"
  ADD CONSTRAINT "idempotency_keys_completed_has_response" CHECK ("status" = 'IN_PROGRESS' OR ("responseStatus" IS NOT NULL AND "responseBody" IS NOT NULL)),
  ADD CONSTRAINT "idempotency_keys_key_not_blank" CHECK (length(trim("key")) > 0);
