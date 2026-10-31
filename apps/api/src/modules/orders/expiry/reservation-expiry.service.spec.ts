import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AdminAction, AdminTargetType } from '@prisma/client';

import { AuditService } from '../../audit/audit.service';
import { OrdersRepository } from '../orders.repository';
import { EXPIRE_OVERDUE_COMMAND, MANUAL_RUN_BUDGET_MS, STALE_RUN_AFTER_MS } from './expiry.constants';
import { MaintenanceRunsRepository } from '../maintenance-runs.repository';
import { ReservationExpiryService } from './reservation-expiry.service';

const group = (id: string, minute: number) => ({ id, createdAt: new Date(Date.UTC(2026, 9, 1, 10, minute)) });

describe('ReservationExpiryService (specs/commerce/23 R0)', () => {
  let orders: {
    findStalePendingGroups: jest.Mock;
    staleBacklog: jest.Mock;
    cancelPendingGroup: jest.Mock;
  };
  let runs: { start: jest.Mock; finish: jest.Mock; closeStale: jest.Mock };
  let audit: { record: jest.Mock };
  let service: ReservationExpiryService;

  beforeEach(() => {
    orders = {
      findStalePendingGroups: jest.fn().mockResolvedValue([]),
      staleBacklog: jest.fn().mockResolvedValue({ count: 0, oldestCreatedAt: null }),
      cancelPendingGroup: jest.fn().mockResolvedValue({ outcome: 'released', cancelledOrderIds: ['o'] }),
    };
    runs = {
      start: jest.fn().mockResolvedValue({ id: 'run-1' }),
      finish: jest.fn().mockResolvedValue(true),
      closeStale: jest.fn().mockResolvedValue(0),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    const config = { get: jest.fn().mockReturnValue(60) } as unknown as ConfigService;
    service = new ReservationExpiryService(
      orders as unknown as OrdersRepository,
      runs as unknown as MaintenanceRunsRepository,
      config,
      audit as unknown as AuditService,
    );
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('uses an application-clock cutoff of now − TTL and writes the run row before touching any group', async () => {
    const before = Date.now();
    orders.findStalePendingGroups.mockResolvedValueOnce([group('g1', 1)]).mockResolvedValueOnce([]);

    await service.run({ triggeredBy: 'schedule', budgetMs: 60_000 });

    const [cutoff] = orders.findStalePendingGroups.mock.calls[0];
    expect(before - 60 * 60_000 - cutoff.getTime()).toBeLessThanOrEqual(0);
    expect(Date.now() - 60 * 60_000 - cutoff.getTime()).toBeGreaterThanOrEqual(0);
    expect(runs.start.mock.invocationCallOrder[0]).toBeLessThan(orders.cancelPendingGroup.mock.invocationCallOrder[0]);
  });

  it('closes stale RUNNING rows by age only, before starting', async () => {
    const now = Date.now();
    await service.run({ triggeredBy: 'schedule', budgetMs: 60_000 });
    const [command, startedBefore] = runs.closeStale.mock.calls[0];
    expect(command).toBe(EXPIRE_OVERDUE_COMMAND);
    expect(Math.abs(now - STALE_RUN_AFTER_MS - startedBefore.getTime())).toBeLessThan(1000);
  });

  it('expires with SKIP LOCKED and the eligibility re-check, looping batches with a cursor past every attempted group', async () => {
    orders.findStalePendingGroups
      .mockResolvedValueOnce([group('g1', 1), group('g2', 2)])
      .mockResolvedValueOnce([group('g3', 3)])
      .mockResolvedValueOnce([]);

    const result = await service.run({ triggeredBy: 'schedule', budgetMs: 60_000, batchSize: 2 });

    expect(orders.cancelPendingGroup).toHaveBeenCalledWith('g1', { lockMode: 'skipLocked', requireExpiryEligibility: true, source: 'expiry' });
    expect(orders.findStalePendingGroups.mock.calls[1][2]).toEqual({ createdAt: group('g2', 2).createdAt, id: 'g2' });
    expect(orders.findStalePendingGroups.mock.calls[2][2]).toEqual({ createdAt: group('g3', 3).createdAt, id: 'g3' });
    expect(result).toMatchObject({ status: 'SUCCEEDED', batches: 2, candidates: 3, processed: 3, released: 3 });
  });

  it('a failing group is counted and skipped; the run continues and ends PARTIAL with the error', async () => {
    orders.findStalePendingGroups.mockResolvedValueOnce([group('g1', 1), group('g2', 2), group('g3', 3)]).mockResolvedValueOnce([]);
    orders.cancelPendingGroup
      .mockRejectedValueOnce(new Error('constraint violated'))
      .mockResolvedValueOnce({ outcome: 'skipped', cancelledOrderIds: [] })
      .mockResolvedValueOnce({ outcome: 'released', cancelledOrderIds: ['a', 'b'] });

    const result = await service.run({ triggeredBy: 'schedule', budgetMs: 60_000 });

    expect(orders.cancelPendingGroup).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ status: 'PARTIAL', processed: 3, released: 1, skipped: 1, failed: 1, ordersCancelled: 2 });
    expect(result.error).toContain('constraint violated');
    expect(runs.finish).toHaveBeenCalledWith('run-1', expect.objectContaining({ status: 'PARTIAL', failed: 1, skipped: 1 }));
  });

  it('processed = released + skipped + failed; "not eligible" counts as skipped', async () => {
    orders.findStalePendingGroups.mockResolvedValueOnce([group('g1', 1), group('g2', 2)]).mockResolvedValueOnce([]);
    orders.cancelPendingGroup
      .mockResolvedValueOnce({ outcome: 'notEligible', cancelledOrderIds: [] })
      .mockResolvedValueOnce({ outcome: 'released', cancelledOrderIds: ['x'] });

    const result = await service.run({ triggeredBy: 'schedule', budgetMs: 60_000 });
    expect(result.processed).toBe(result.released + result.skipped + result.failed);
    expect(result).toMatchObject({ status: 'SUCCEEDED', skipped: 1, released: 1 });
  });

  it('stops at the time budget between groups', async () => {
    const realNow = Date.now;
    let clock = realNow();
    jest.spyOn(Date, 'now').mockImplementation(() => clock);
    orders.findStalePendingGroups.mockResolvedValueOnce([group('g1', 1), group('g2', 2)]);
    orders.cancelPendingGroup.mockImplementation(async () => {
      clock += 10_000; // each group takes 10 s
      return { outcome: 'released', cancelledOrderIds: ['o'] };
    });

    const result = await service.run({ triggeredBy: 'schedule', budgetMs: 5_000 });

    expect(orders.cancelPendingGroup).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: 'SUCCEEDED', processed: 1, released: 1 });
  });

  it('stops between groups on shutdown and ends PARTIAL with error "shutdown"', async () => {
    orders.findStalePendingGroups.mockResolvedValueOnce([group('g1', 1), group('g2', 2)]);
    orders.cancelPendingGroup.mockImplementation(async () => {
      service.beforeApplicationShutdown();
      return { outcome: 'released', cancelledOrderIds: ['o'] };
    });

    const result = await service.run({ triggeredBy: 'schedule', budgetMs: 60_000 });

    expect(orders.cancelPendingGroup).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: 'PARTIAL', error: 'shutdown', processed: 1 });
  });

  it('a run-level failure (candidate query) is recorded as FAILED, not thrown', async () => {
    orders.findStalePendingGroups.mockRejectedValueOnce(new Error('connection refused'));
    const result = await service.run({ triggeredBy: 'schedule', budgetMs: 60_000 });
    expect(result.status).toBe('FAILED');
    expect(runs.finish).toHaveBeenCalledWith('run-1', expect.objectContaining({ status: 'FAILED', error: 'connection refused' }));
  });

  it('does not start (and processes nothing) when the run row cannot be written', async () => {
    runs.start.mockRejectedValueOnce(new Error('database down'));
    await expect(service.run({ triggeredBy: 'schedule', budgetMs: 60_000 })).rejects.toThrow('database down');
    expect(orders.findStalePendingGroups).not.toHaveBeenCalled();
    expect(orders.cancelPendingGroup).not.toHaveBeenCalled();
  });

  it('never overwrites a row already closed as stale', async () => {
    runs.finish.mockResolvedValueOnce(false);
    await expect(service.run({ triggeredBy: 'schedule', budgetMs: 60_000 })).resolves.toMatchObject({ status: 'SUCCEEDED' });
    expect(runs.finish).toHaveBeenCalledTimes(1);
  });

  it('records the backlog snapshot (count, oldest deadline = oldest createdAt + TTL)', async () => {
    const oldest = new Date(Date.UTC(2026, 9, 1, 8, 0));
    orders.staleBacklog.mockResolvedValueOnce({ count: 7, oldestCreatedAt: oldest });
    await service.run({ triggeredBy: 'schedule', budgetMs: 60_000 });
    expect(runs.start).toHaveBeenCalledWith(
      expect.objectContaining({
        command: EXPIRE_OVERDUE_COMMAND,
        triggeredBy: 'schedule',
        backlogAtStart: 7,
        oldestOverdueAtStart: new Date(oldest.getTime() + 60 * 60_000),
      }),
    );
  });

  describe('runManual', () => {
    it('runs with the manual budget, triggeredBy = admin id, and attempts one audit row even when nothing is released', async () => {
      const runSpy = jest.spyOn(service, 'run');
      const result = await service.runManual('admin-1', 'backlog after outage');

      expect(runSpy).toHaveBeenCalledWith({ triggeredBy: 'admin-1', budgetMs: MANUAL_RUN_BUDGET_MS });
      expect(result.released).toBe(0);
      expect(audit.record).toHaveBeenCalledWith({
        actorId: 'admin-1',
        action: AdminAction.MAINTENANCE_EXPIRE_OVERDUE,
        targetType: AdminTargetType.MAINTENANCE_RUN,
        targetId: 'run-1',
        reason: 'backlog after outage',
      });
    });
  });
});
