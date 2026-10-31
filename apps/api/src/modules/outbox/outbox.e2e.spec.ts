import { Logger } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { OutboxDeliveryStatus, OutboxEvent, Prisma, Role } from '@prisma/client';

import { writeOutboxEvent } from '../../infra/outbox/outbox-writer';
import { OUTBOX_CONSUMER_ALLOW_LIST, OUTBOX_CONSUMER_REGISTRY } from '../../infra/outbox/outbox.registry';
import { PrismaModule } from '../../infra/prisma/prisma.module';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { AuditModule } from '../audit/audit.module';
import { AuditService } from '../audit/audit.service';
import { OUTBOX_HANDLERS, OUTBOX_LEASE_MS } from './outbox.constants';
import { OutboxRepository } from './outbox.repository';
import { NonRetryableOutboxError, OutboxHandler, OutboxService } from './outbox.service';

/**
 * Transactional outbox on real PostgreSQL (specs/commerce/01 §7, AT-OB-*, C-O*).
 * A test consumer stands in for the notifications module; its effect is a row in
 * a test table so exactly-once effects can be counted.
 */
const TEST_REGISTRY = { 'test.event': ['test-consumer'], 'test.unhandled': ['ghost-consumer'] };

describe('Transactional outbox (e2e, real PostgreSQL)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let outbox: OutboxService;
  let repo: OutboxRepository;
  let adminId: string;
  let behaviour: 'ok' | 'retryable' | 'poison' | 'slow' = 'ok';
  let slowGate: Promise<void> = Promise.resolve();

  const handler: OutboxHandler = {
    consumer: 'test-consumer',
    async handle(event: OutboxEvent, tx: Prisma.TransactionClient) {
      if (behaviour === 'retryable') throw new Error('provider timeout');
      if (behaviour === 'poison') throw new NonRetryableOutboxError('bad payload');
      if (behaviour === 'slow') await slowGate;
      await tx.$executeRaw`INSERT INTO "outbox_test_effects" ("eventId") VALUES (${event.id})`;
    },
  };

  beforeAll(async () => {
    if (!/\/[^/?]+_test(\?|$)/.test(process.env.DATABASE_URL ?? '')) {
      throw new Error('outbox e2e must run against a *_test database.');
    }
    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), PrismaModule, AuditModule],
      providers: [OutboxRepository, OutboxService, { provide: OUTBOX_HANDLERS, useValue: [handler] }],
    }).compile();
    prisma = moduleRef.get(PrismaService);
    outbox = moduleRef.get(OutboxService);
    repo = moduleRef.get(OutboxRepository);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await prisma.$executeRawUnsafe('TRUNCATE "inventory_movements"'); // append-only ledger (commerce/25 S3) → variants, groups, users are RESTRICT
    await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "outbox_test_effects" ("eventId" TEXT NOT NULL)`);
    await prisma.adminAuditLog.deleteMany({ where: { actor: { email: 'obx-admin@example.com' } } });
    await prisma.user.deleteMany({ where: { email: 'obx-admin@example.com' } });
    adminId = (await prisma.user.create({ data: { email: 'obx-admin@example.com', passwordHash: 'x', name: 'A', role: Role.ADMIN } })).id;
  });

  afterAll(async () => {
    await reset();
    await prisma.$executeRawUnsafe('TRUNCATE "inventory_movements"'); // append-only ledger (commerce/25 S3) → variants, groups, users are RESTRICT
    await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "outbox_test_effects"`);
    await prisma.adminAuditLog.deleteMany({ where: { actorId: adminId } });
    await prisma.user.deleteMany({ where: { id: adminId } });
    await moduleRef.close();
  });

  beforeEach(async () => {
    behaviour = 'ok';
    await reset();
  });

  /** Outbox rows are append-only (DELETE is refused by trigger); TRUNCATE is the test reset. */
  async function reset() {
    await prisma.$executeRawUnsafe(`TRUNCATE "processed_events", "outbox_deliveries", "outbox_events", "outbox_test_effects"`);
    await prisma.maintenanceRun.deleteMany({ where: { command: 'OUTBOX_DRAIN' } });
  }

  const effects = async () => (await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "outbox_test_effects"`)[0].n;

  async function emit(n = 1, type = 'test.event'): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      ids.push(
        await prisma.$transaction((tx) =>
          writeOutboxEvent(tx, { aggregateType: 'test', aggregateId: `agg-${i}`, type, payload: { i } }, TEST_REGISTRY),
        ),
      );
    }
    return ids;
  }

  it('OBX-01: event and one delivery per registered consumer are written in the business transaction — or not at all', async () => {
    await emit(1);
    await expect(
      prisma.$transaction(async (tx) => {
        await writeOutboxEvent(tx, { aggregateType: 'test', aggregateId: 'rolled-back', type: 'test.event', payload: {} }, TEST_REGISTRY);
        throw new Error('business rule failed');
      }),
    ).rejects.toThrow('business rule failed');

    expect(await prisma.outboxEvent.count()).toBe(1);
    expect(await prisma.outboxDelivery.count({ where: { consumer: 'test-consumer', status: OutboxDeliveryStatus.PENDING } })).toBe(1);
  });

  it('per-aggregate sequence increments; the unique (aggregate, sequence) refuses a duplicate', async () => {
    await prisma.$transaction((tx) => writeOutboxEvent(tx, { aggregateType: 'g', aggregateId: '1', type: 'test.event', payload: {} }, TEST_REGISTRY));
    await prisma.$transaction((tx) => writeOutboxEvent(tx, { aggregateType: 'g', aggregateId: '1', type: 'test.event', payload: {} }, TEST_REGISTRY));
    const seq = (await prisma.outboxEvent.findMany({ where: { aggregateId: '1' }, orderBy: { sequence: 'asc' } })).map((e) => e.sequence);
    expect(seq).toEqual([1, 2]);
    await expect(
      prisma.outboxEvent.create({ data: { aggregateType: 'g', aggregateId: '1', sequence: 2, type: 'x', payload: {} } }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('AT-OB-01: a crash after commit loses nothing — the next drain processes it once', async () => {
    await emit(3);
    const result = await outbox.drain({ triggeredBy: 'boot' });
    expect(result).toMatchObject({ status: 'SUCCEEDED', claimed: 3, processed: 3 });
    expect(await effects()).toBe(3n);
    expect(await prisma.outboxDelivery.count({ where: { status: OutboxDeliveryStatus.PROCESSED } })).toBe(3);
  });

  it('AT-OB-02: a retryable failure returns the delivery to PENDING with backoff and the error; the event row is intact', async () => {
    await emit(1);
    behaviour = 'retryable';
    const result = await outbox.drain({ triggeredBy: 'test' });
    expect(result).toMatchObject({ status: 'PARTIAL', retried: 1 });
    const d = await prisma.outboxDelivery.findFirstOrThrow();
    expect(d).toMatchObject({ status: OutboxDeliveryStatus.PENDING, attempts: 1, lastError: 'provider timeout', leaseOwner: null });
    expect(d.availableAt.getTime()).toBeGreaterThan(Date.now() - 2_000); // ~now + 1 s (database time)
    expect(await effects()).toBe(0n);

    behaviour = 'ok';
    await prisma.$executeRaw`UPDATE "outbox_deliveries" SET "availableAt" = now()`; // skip the wait
    await outbox.drain({ triggeredBy: 'test' });
    expect(await effects()).toBe(1n);
  });

  it('AT-OB-03: replaying a processed delivery has no second effect (processed_events)', async () => {
    await emit(1);
    await outbox.drain({ triggeredBy: 'test' });
    // Force a replay: put the delivery back as if a late copy were claimed again.
    await prisma.$executeRaw`UPDATE "outbox_deliveries" SET "status" = 'PENDING', "availableAt" = now()`;
    const replay = await outbox.drain({ triggeredBy: 'test' });
    expect(replay).toMatchObject({ processed: 0, duplicates: 1 });
    expect(await effects()).toBe(1n);
  });

  it('C-O1: two drains at once process every delivery exactly once', async () => {
    await emit(40);
    const other = moduleRef.get(OutboxService);
    // A second service instance (separate drain flag) on the same database.
    const second = new OutboxService(repo, moduleRef.get(AuditService), [handler]);
    const [a, b] = await Promise.all([other.drain({ triggeredBy: 'a' }), second.drain({ triggeredBy: 'b' })]);
    expect(a.processed + b.processed).toBe(40);
    expect(await effects()).toBe(40n);
  });

  it('C-O3 / C-O4: an expired lease is reclaimed by another instance; the late original owner cannot complete (rolls back)', async () => {
    await emit(1);
    const [claimed] = await repo.claim('instance-A', 1, OUTBOX_LEASE_MS);
    expect(claimed.status).toBe(OutboxDeliveryStatus.PROCESSING);
    await prisma.$executeRaw`UPDATE "outbox_deliveries" SET "leaseUntil" = now() - interval '1 second'`; // A hung past its lease

    const b = await outbox.drain({ triggeredBy: 'instance-B' });
    expect(b.processed).toBe(1);
    const d = await prisma.outboxDelivery.findFirstOrThrow();
    expect(d).toMatchObject({ status: OutboxDeliveryStatus.PROCESSED, attempts: 2 });

    // A finally finishes: its guarded completion matches nothing and its transaction rolls back.
    await expect(repo.processInTransaction(claimed, 'instance-A', async () => undefined)).rejects.toThrow('lease lost');
    expect(await effects()).toBe(1n);
  });

  it('AT-OB-08: poison input goes DEAD at once; an unregistered consumer goes DEAD; healthy deliveries still process', async () => {
    await emit(3);
    await emit(1, 'test.unhandled');
    behaviour = 'poison';
    const first = await outbox.drain({ triggeredBy: 'test' });
    expect(first.dead).toBe(4);
    expect(await prisma.outboxDelivery.count({ where: { status: OutboxDeliveryStatus.DEAD } })).toBe(4);
    const ghost = await prisma.outboxDelivery.findFirstOrThrow({ where: { consumer: 'ghost-consumer' } });
    expect(ghost.lastError).toContain('no handler registered');
  });

  it('a retryable failure becomes DEAD after the maximum attempts', async () => {
    await emit(1);
    behaviour = 'retryable';
    await prisma.$executeRaw`UPDATE "outbox_deliveries" SET "attempts" = 9`;
    await outbox.drain({ triggeredBy: 'test' }); // claim makes it 10
    expect((await prisma.outboxDelivery.findFirstOrThrow()).status).toBe(OutboxDeliveryStatus.DEAD);
  });

  it('AT-OB-09: requeue is DEAD → PENDING only, audited with the reason; then it processes', async () => {
    await emit(1);
    behaviour = 'poison';
    await outbox.drain({ triggeredBy: 'test' });
    const d = await prisma.outboxDelivery.findFirstOrThrow();

    behaviour = 'ok';
    const requeued = await outbox.requeueForAdmin(adminId, d.id, 'consumer fixed in release 42');
    expect(requeued).toMatchObject({ status: OutboxDeliveryStatus.PENDING, attempts: 0 });
    await expect(outbox.requeueForAdmin(adminId, d.id, 'again, should be refused')).rejects.toMatchObject({
      response: { code: 'OUTBOX_DELIVERY_NOT_DEAD' },
    });
    expect(await prisma.adminAuditLog.count({ where: { actorId: adminId, action: 'OUTBOX_DELIVERY_REQUEUED', targetId: d.id } })).toBe(1);
    await outbox.drain({ triggeredBy: 'test' });
    expect(await effects()).toBe(1n);
  });

  it('append-only: events cannot be updated or deleted; deliveries cannot be deleted', async () => {
    await emit(1);
    await expect(prisma.$executeRaw`UPDATE "outbox_events" SET "type" = 'tampered'`).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRaw`DELETE FROM "outbox_deliveries"`).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRaw`DELETE FROM "outbox_events"`).rejects.toThrow(/append-only|foreign key/);
  });

  it('CHECK: a PROCESSING delivery always has a lease owner and expiry', async () => {
    await emit(1);
    await expect(prisma.$executeRaw`UPDATE "outbox_deliveries" SET "status" = 'PROCESSING'`).rejects.toThrow(/outbox_deliveries_lease_check/);
  });

  it('records each non-empty drain in maintenance_runs (OUTBOX_DRAIN); an empty boot sweep records nothing', async () => {
    await outbox.drain({ triggeredBy: 'boot' });
    expect(await prisma.maintenanceRun.count({ where: { command: 'OUTBOX_DRAIN' } })).toBe(0);
    await emit(2);
    const result = await outbox.drain({ triggeredBy: 'schedule' });
    expect(await prisma.maintenanceRun.findUniqueOrThrow({ where: { id: result.runId! } })).toMatchObject({
      command: 'OUTBOX_DRAIN',
      status: 'SUCCEEDED',
      processed: 2,
      released: 2,
    });
  });

  it('AT-OB-10: every consumer in the production registry is on the allow-list (notifications only — no money or stock)', () => {
    for (const consumers of Object.values(OUTBOX_CONSUMER_REGISTRY)) {
      for (const consumer of consumers) expect(OUTBOX_CONSUMER_ALLOW_LIST).toContain(consumer);
    }
  });

  it('a slow consumer holds only its own delivery; a second drain on the same instance is refused (one drain per instance)', async () => {
    await emit(1);
    behaviour = 'slow';
    let open!: () => void;
    slowGate = new Promise((r) => (open = r));
    const running = outbox.drain({ triggeredBy: 'a' });
    await new Promise((r) => setTimeout(r, 100));
    await expect(outbox.drain({ triggeredBy: 'b' })).resolves.toMatchObject({ status: 'SKIPPED_BUSY' });
    open();
    await expect(running).resolves.toMatchObject({ processed: 1 });
  });

  it('the admin drain is audited on every ACCEPTED call — even an empty one — and a refused (busy) call records nothing', async () => {
    const before = await prisma.adminAuditLog.count({ where: { actorId: adminId, action: 'OUTBOX_DRAIN_REQUESTED' } });
    await expect(outbox.drainForAdmin(adminId)).resolves.toMatchObject({ claimed: 0 }); // nothing pending
    expect(await prisma.adminAuditLog.count({ where: { actorId: adminId, action: 'OUTBOX_DRAIN_REQUESTED' } })).toBe(before + 1);

    await emit(1);
    behaviour = 'slow';
    let open!: () => void;
    slowGate = new Promise((r) => (open = r));
    const running = outbox.drain({ triggeredBy: 'a' });
    await new Promise((r) => setTimeout(r, 100));
    await expect(outbox.drainForAdmin(adminId)).rejects.toMatchObject({ status: 409, response: { code: 'OUTBOX_DRAIN_IN_PROGRESS' } });
    open();
    await running;
    expect(await prisma.adminAuditLog.count({ where: { actorId: adminId, action: 'OUTBOX_DRAIN_REQUESTED' } })).toBe(before + 1);
  });
});

