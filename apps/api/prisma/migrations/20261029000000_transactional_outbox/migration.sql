-- Transactional outbox (specs/commerce/01 §7, 02 §3.9, 23 R3; TD-06, TD-23).
-- Additive only: one enum type, three audit enum values, three tables.

CREATE TYPE "public"."OutboxDeliveryStatus" AS ENUM ('PENDING', 'PROCESSING', 'PROCESSED', 'DEAD');

ALTER TYPE "public"."AdminAction" ADD VALUE 'OUTBOX_DRAIN_REQUESTED';
ALTER TYPE "public"."AdminAction" ADD VALUE 'OUTBOX_DELIVERY_REQUEUED';
ALTER TYPE "public"."AdminTargetType" ADD VALUE 'OUTBOX';

CREATE TABLE "public"."outbox_events" (
    "id" TEXT NOT NULL,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "payloadVersion" INTEGER NOT NULL DEFAULT 1,
    "correlationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."outbox_deliveries" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "consumer" TEXT NOT NULL,
    "status" "public"."OutboxDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseOwner" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "lastError" TEXT,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_deliveries_pkey" PRIMARY KEY ("id"),
    -- a PROCESSING delivery always has an owner and a lease (01 §7.4)
    CONSTRAINT "outbox_deliveries_lease_check" CHECK ("status" <> 'PROCESSING' OR ("leaseOwner" IS NOT NULL AND "leaseUntil" IS NOT NULL)),
    CONSTRAINT "outbox_deliveries_attempts_check" CHECK ("attempts" >= 0)
);

CREATE TABLE "public"."processed_events" (
    "consumer" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_events_pkey" PRIMARY KEY ("consumer","eventId")
);

CREATE INDEX "outbox_events_type_createdAt_idx" ON "public"."outbox_events"("type", "createdAt");
CREATE UNIQUE INDEX "outbox_events_aggregateType_aggregateId_sequence_key" ON "public"."outbox_events"("aggregateType", "aggregateId", "sequence");
CREATE INDEX "outbox_deliveries_status_availableAt_idx" ON "public"."outbox_deliveries"("status", "availableAt");
CREATE INDEX "outbox_deliveries_status_leaseUntil_idx" ON "public"."outbox_deliveries"("status", "leaseUntil");
CREATE UNIQUE INDEX "outbox_deliveries_eventId_consumer_key" ON "public"."outbox_deliveries"("eventId", "consumer");

ALTER TABLE "public"."outbox_deliveries" ADD CONSTRAINT "outbox_deliveries_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "public"."outbox_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "public"."processed_events" ADD CONSTRAINT "processed_events_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "public"."outbox_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Append-only guards (01 §7.3: events and deliveries are never deleted by the
-- application; events are never edited). Row triggers do not fire on TRUNCATE,
-- which only test cleanup uses.
CREATE OR REPLACE FUNCTION "public"."outbox_append_only_guard"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'outbox rows are append-only (% on %)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER "outbox_events_no_update" BEFORE UPDATE ON "public"."outbox_events"
  FOR EACH ROW EXECUTE FUNCTION "public"."outbox_append_only_guard"();
CREATE TRIGGER "outbox_events_no_delete" BEFORE DELETE ON "public"."outbox_events"
  FOR EACH ROW EXECUTE FUNCTION "public"."outbox_append_only_guard"();
CREATE TRIGGER "outbox_deliveries_no_delete" BEFORE DELETE ON "public"."outbox_deliveries"
  FOR EACH ROW EXECUTE FUNCTION "public"."outbox_append_only_guard"();
CREATE TRIGGER "processed_events_no_delete" BEFORE DELETE ON "public"."processed_events"
  FOR EACH ROW EXECUTE FUNCTION "public"."outbox_append_only_guard"();
