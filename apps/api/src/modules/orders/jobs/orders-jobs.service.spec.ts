import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';

import { MaintenanceRunsRepository } from '../maintenance-runs.repository';
import {
  EXPIRE_PENDING_JOB,
  EXPIRY_INTERVAL_MS,
  EXPIRY_JOB_TEMPLATE_OPTIONS,
  EXPIRY_PATTERN,
  EXPIRY_SCHEDULER_ID,
  isScheduleHealthy,
  OrdersJobsService,
  ownsExpirySchedule,
} from './orders-jobs.service';

describe('OrdersJobsService — schedule ownership and reconciliation (specs/commerce/21 §8.2, 23 R1)', () => {
  let queue: { getJobScheduler: jest.Mock; upsertJobScheduler: jest.Mock; on: jest.Mock };
  let runs: { recordInstant: jest.Mock };
  let role: string;
  let service: OrdersJobsService;

  beforeEach(() => {
    queue = { getJobScheduler: jest.fn(), upsertJobScheduler: jest.fn().mockResolvedValue({}), on: jest.fn() };
    runs = { recordInstant: jest.fn().mockResolvedValue({}) };
    role = 'all';
    const config = { get: jest.fn(() => role) } as unknown as ConfigService;
    service = new OrdersJobsService(queue as unknown as Queue, config, runs as unknown as MaintenanceRunsRepository);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    service.onModuleDestroy();
    jest.restoreAllMocks();
  });

  it('only "api" gives up ownership', () => {
    expect(ownsExpirySchedule('all')).toBe(true);
    expect(ownsExpirySchedule('worker')).toBe(true);
    expect(ownsExpirySchedule(undefined)).toBe(true);
    expect(ownsExpirySchedule('api')).toBe(false);
  });

  it('healthy = present, */10, next not more than one interval overdue', () => {
    const now = Date.now();
    expect(isScheduleHealthy(undefined, now)).toBe(false);
    expect(isScheduleHealthy({ key: 'k', name: 'n', pattern: '*/5 * * * *', next: now + 1000 }, now)).toBe(false);
    expect(isScheduleHealthy({ key: 'k', name: 'n', pattern: EXPIRY_PATTERN }, now)).toBe(false);
    expect(isScheduleHealthy({ key: 'k', name: 'n', pattern: EXPIRY_PATTERN, next: now - EXPIRY_INTERVAL_MS - 1 }, now)).toBe(false);
    expect(isScheduleHealthy({ key: 'k', name: 'n', pattern: EXPIRY_PATTERN, next: now + 60_000 }, now)).toBe(true);
  });

  it('a healthy schedule is left alone and nothing is recorded', async () => {
    queue.getJobScheduler.mockResolvedValue({ key: 'k', name: 'n', pattern: EXPIRY_PATTERN, next: Date.now() + 60_000 });
    await expect(service.reconcile()).resolves.toBe('healthy');
    expect(queue.upsertJobScheduler).not.toHaveBeenCalled();
    expect(runs.recordInstant).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', undefined],
    ['old */5 pattern (transition from today)', { key: 'k', name: 'n', pattern: '*/5 * * * *', next: Date.now() + 1000 }],
    ['next job lost (partial data loss)', { key: 'k', name: 'n', pattern: EXPIRY_PATTERN, next: Date.now() - 2 * EXPIRY_INTERVAL_MS }],
  ])('recreates under the same fixed id when %s, and records it (A8)', async (_label, scheduler) => {
    queue.getJobScheduler.mockResolvedValue(scheduler);
    await expect(service.reconcile()).resolves.toBe('recreated');
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      EXPIRY_SCHEDULER_ID,
      { pattern: EXPIRY_PATTERN },
      { name: EXPIRE_PENDING_JOB, data: {}, opts: EXPIRY_JOB_TEMPLATE_OPTIONS },
    );
    expect(runs.recordInstant).toHaveBeenCalledWith('SCHEDULE_RECONCILE', 'reconciler', 'SUCCEEDED', expect.stringContaining('recreated'));
  });

  it('job template: empty payload, one attempt, bounded retention', () => {
    expect(EXPIRY_JOB_TEMPLATE_OPTIONS).toEqual({
      attempts: 1,
      removeOnComplete: { count: 100, age: 86_400 },
      removeOnFail: { count: 1_000, age: 604_800 },
    });
  });

  it('a failing check is counted (A14) and never throws; a success resets the counter', async () => {
    queue.getJobScheduler.mockRejectedValueOnce(new Error('ECONNREFUSED')).mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(service.reconcile()).resolves.toBe('failed');
    await expect(service.reconcile()).resolves.toBe('failed');
    expect(service.consecutiveReconcileFailures).toBe(2);
    queue.getJobScheduler.mockResolvedValueOnce({ key: 'k', name: 'n', pattern: EXPIRY_PATTERN, next: Date.now() + 1 });
    await expect(service.reconcile()).resolves.toBe('healthy');
    expect(service.consecutiveReconcileFailures).toBe(0);
  });

  it('is single-flight: a check while one is in flight is skipped', async () => {
    let resolve!: (v: unknown) => void;
    queue.getJobScheduler.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const first = service.reconcile();
    await expect(service.reconcile()).resolves.toBe('busy');
    resolve({ key: 'k', name: 'n', pattern: EXPIRY_PATTERN, next: Date.now() + 1 });
    await expect(first).resolves.toBe('healthy');
  });

  it('a failure to record the recreation does not undo it', async () => {
    queue.getJobScheduler.mockResolvedValue(undefined);
    runs.recordInstant.mockRejectedValueOnce(new Error('database down'));
    await expect(service.reconcile()).resolves.toBe('recreated');
  });

  it('the API in role "api" never reconciles or schedules', async () => {
    role = 'api';
    service.onApplicationBootstrap();
    await expect(service.reconcile()).resolves.toBe('not-owner');
    expect(queue.getJobScheduler).not.toHaveBeenCalled();
    expect(queue.upsertJobScheduler).not.toHaveBeenCalled();
  });

  it('boot reconciliation does not block startup', () => {
    queue.getJobScheduler.mockReturnValue(new Promise(() => undefined)); // never resolves
    expect(() => service.onApplicationBootstrap()).not.toThrow();
  });
});
