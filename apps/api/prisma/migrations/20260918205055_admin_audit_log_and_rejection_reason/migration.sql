-- CreateEnum
CREATE TYPE "public"."AdminAction" AS ENUM ('VENDOR_VERIFIED', 'VENDOR_REJECTED', 'ORGANIZER_VERIFIED', 'ORGANIZER_REJECTED', 'PRODUCT_APPROVED', 'PRODUCT_REJECTED', 'USER_DEACTIVATED', 'USER_REACTIVATED');

-- CreateEnum
CREATE TYPE "public"."AdminTargetType" AS ENUM ('VENDOR', 'ORGANIZER', 'PRODUCT', 'USER');

-- AlterTable
ALTER TABLE "public"."vendors" ADD COLUMN     "rejectionReason" TEXT;

-- AlterTable
ALTER TABLE "public"."organizers" ADD COLUMN     "rejectionReason" TEXT;

-- CreateTable
CREATE TABLE "public"."admin_audit_logs" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "action" "public"."AdminAction" NOT NULL,
    "targetType" "public"."AdminTargetType" NOT NULL,
    "targetId" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "admin_audit_logs_actorId_idx" ON "public"."admin_audit_logs"("actorId");

-- CreateIndex
CREATE INDEX "admin_audit_logs_targetType_targetId_idx" ON "public"."admin_audit_logs"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "admin_audit_logs_createdAt_idx" ON "public"."admin_audit_logs"("createdAt");

-- AddForeignKey
ALTER TABLE "public"."admin_audit_logs" ADD CONSTRAINT "admin_audit_logs_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

