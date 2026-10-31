-- Reservation maintenance R0 (specs/commerce/23 §11.6, DB-1 – DB-3).
-- Additive only: two enum values for the manual expire-overdue audit row and the
-- maintenance_runs table. No existing table, column or index is touched.
-- Rollback rule: revert code only; keep this table and the enum values.

-- DB-2 / DB-3
ALTER TYPE "public"."AdminAction" ADD VALUE 'MAINTENANCE_EXPIRE_OVERDUE';
ALTER TYPE "public"."AdminTargetType" ADD VALUE 'MAINTENANCE_RUN';

-- DB-1
CREATE TABLE "public"."maintenance_runs" (
    "id" TEXT NOT NULL,
    "command" TEXT NOT NULL,
    "triggeredBy" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "jobId" TEXT,
    "scheduledFor" TIMESTAMP(3),
    "workerInstance" TEXT,
    "batches" INTEGER,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "candidates" INTEGER,
    "processed" INTEGER,
    "released" INTEGER,
    "skipped" INTEGER,
    "failed" INTEGER,
    "backlogAtStart" INTEGER,
    "oldestOverdueAtStart" TIMESTAMP(3),
    "catchUp" BOOLEAN NOT NULL DEFAULT false,
    "stalledAttempt" INTEGER,
    "error" TEXT,

    CONSTRAINT "maintenance_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "maintenance_runs_command_startedAt_idx" ON "public"."maintenance_runs"("command", "startedAt");
