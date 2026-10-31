import { Injectable } from '@nestjs/common';
import { MaintenanceRun } from '@prisma/client';

import { PrismaService } from '../../infra/prisma/prisma.service';

export type MaintenanceRunStatus = 'RUNNING' | 'SUCCEEDED' | 'PARTIAL' | 'FAILED';

export interface MaintenanceRunStart {
  command: string;
  triggeredBy: string;
  jobId?: string | null;
  scheduledFor?: Date | null;
  workerInstance?: string | null;
  backlogAtStart: number;
  oldestOverdueAtStart: Date | null;
  catchUp: boolean;
}

export interface MaintenanceRunFinish {
  status: Exclude<MaintenanceRunStatus, 'RUNNING'>;
  batches: number;
  candidates: number;
  processed: number;
  released: number;
  skipped: number;
  failed: number;
  error: string | null;
}

/** Every Prisma call for maintenance_runs (specs/commerce/23 §11.4, §11.7). */
@Injectable()
export class MaintenanceRunsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Written before any group is processed; if this fails, the run does not start. */
  start(data: MaintenanceRunStart): Promise<MaintenanceRun> {
    return this.prisma.maintenanceRun.create({ data: { ...data, status: 'RUNNING' } });
  }

  /**
   * Guarded: only the run's own RUNNING row is finalized. Returns false when the
   * row was already closed (e.g. as stale) — the caller logs and never overwrites.
   */
  async finish(id: string, data: MaintenanceRunFinish): Promise<boolean> {
    const result = await this.prisma.maintenanceRun.updateMany({
      where: { id, status: 'RUNNING' },
      data: { ...data, finishedAt: new Date() },
    });
    return result.count === 1;
  }

  /**
   * Closes RUNNING rows of `command` that started before `startedBefore` — a run
   * whose process died. Age is the only criterion: a concurrent run that is still
   * alive is younger than the threshold. One statement, so two closers close a
   * row once.
   */
  async closeStale(command: string, startedBefore: Date): Promise<number> {
    const result = await this.prisma.maintenanceRun.updateMany({
      where: { command, status: 'RUNNING', startedAt: { lt: startedBefore } },
      data: { status: 'FAILED', error: 'stale', finishedAt: new Date() },
    });
    return result.count;
  }

  /** A one-step event recorded as an already-finished run (e.g. the reconciler recreating the schedule — alert A8). */
  recordInstant(command: string, triggeredBy: string, status: Exclude<MaintenanceRunStatus, 'RUNNING'>, error: string | null): Promise<MaintenanceRun> {
    return this.prisma.maintenanceRun.create({ data: { command, triggeredBy, status, error, finishedAt: new Date() } });
  }

  findById(id: string): Promise<MaintenanceRun | null> {
    return this.prisma.maintenanceRun.findUnique({ where: { id } });
  }

  /** The latest finished run of a command with one of `statuses` (health checks). */
  findLatestFinished(command: string, statuses: MaintenanceRunStatus[]): Promise<MaintenanceRun | null> {
    return this.prisma.maintenanceRun.findFirst({
      where: { command, status: { in: statuses }, finishedAt: { not: null } },
      orderBy: { finishedAt: 'desc' },
    });
  }

  /** Recent runs of a command, newest first (health checks). */
  findRecent(command: string, take: number): Promise<MaintenanceRun[]> {
    return this.prisma.maintenanceRun.findMany({ where: { command }, orderBy: { startedAt: 'desc' }, take });
  }

  /** Health-check counters, in one round trip. */
  async healthSnapshot(command: string, now: Date) {
    const since = (ms: number) => new Date(now.getTime() - ms);
    const [lastSuccess, lastStarted, firstEver, overBudget, staleClosed, recreated] = await this.prisma.$transaction([
      this.prisma.maintenanceRun.findFirst({
        where: { command, status: { in: ['SUCCEEDED', 'PARTIAL'] }, finishedAt: { not: null } },
        orderBy: { finishedAt: 'desc' },
        select: { finishedAt: true },
      }),
      this.prisma.maintenanceRun.findFirst({ where: { command }, orderBy: { startedAt: 'desc' }, select: { startedAt: true } }),
      this.prisma.maintenanceRun.findFirst({ where: { command }, orderBy: { startedAt: 'asc' }, select: { startedAt: true } }),
      this.prisma.maintenanceRun.count({ where: { command, status: 'RUNNING', startedAt: { lt: since(5 * 60_000) } } }),
      this.prisma.maintenanceRun.count({ where: { command, error: 'stale', finishedAt: { gte: since(60 * 60_000) } } }),
      this.prisma.maintenanceRun.count({ where: { command: 'SCHEDULE_RECONCILE', startedAt: { gte: since(24 * 60 * 60_000) } } }),
    ]);
    return {
      lastSuccessAt: lastSuccess?.finishedAt ?? null,
      lastStartedAt: lastStarted?.startedAt ?? null,
      firstEverAt: firstEver?.startedAt ?? null,
      runningOverBudget: overBudget,
      staleClosedLastHour: staleClosed,
      scheduleRecreatedLast24h: recreated,
    };
  }
}
