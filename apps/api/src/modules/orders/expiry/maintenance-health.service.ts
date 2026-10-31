import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { MaintenanceRunsRepository } from '../maintenance-runs.repository';
import { OrdersRepository } from '../orders.repository';
import { OrdersJobsService, ownsExpirySchedule, ProcessRole } from '../jobs/orders-jobs.service';
import { EXPIRE_OVERDUE_COMMAND } from './expiry.constants';

export type AlertSeverity = 'P1' | 'P2' | 'P3';

export interface AlertCondition {
  code: string; // A1 … A15 of specs/commerce/21 §8.6
  severity: AlertSeverity;
  detail: string;
}

export interface MaintenanceHealth {
  status: 'ok' | 'alert';
  checkedAt: string;
  conditions: AlertCondition[];
}

const MINUTE = 60_000;
const NO_SUCCESS_AFTER_MS = 25 * MINUTE; // A1: two missed 10-min ticks + budget + margin
const OVERDUE_MARGIN_MS = 30 * MINUTE; // A5
const BACKLOG_THRESHOLD = 500; // A6

/**
 * Evaluates the reservation-maintenance alert conditions from PostgreSQL
 * (specs/commerce/21 §8.6, 22 §4.3 M5) — outside the worker and outside Redis.
 * A7 (release integrity) needs the inventory movement ledger (commerce Phase 1)
 * and is not evaluated yet.
 */
@Injectable()
export class MaintenanceHealthService {
  constructor(
    private readonly runsRepository: MaintenanceRunsRepository,
    private readonly ordersRepository: OrdersRepository,
    private readonly jobsService: OrdersJobsService,
    private readonly configService: ConfigService,
  ) {}

  async evaluate(now = new Date(), processStartedAt = new Date(Date.now() - process.uptime() * 1000)): Promise<MaintenanceHealth> {
    const conditions: AlertCondition[] = [];
    const ttlMs = (this.configService.get<number>('CHECKOUT_PENDING_TTL_MINUTES') ?? 60) * MINUTE;
    const snapshot = await this.runsRepository.healthSnapshot(EXPIRE_OVERDUE_COMMAND, now);
    const recent = await this.runsRepository.findRecent(EXPIRE_OVERDUE_COMMAND, 3);
    const overdue = await this.ordersRepository.staleBacklog(new Date(now.getTime() - ttlMs - OVERDUE_MARGIN_MS));
    const age = (date: Date | null) => (date ? now.getTime() - date.getTime() : Number.POSITIVE_INFINITY);

    // A1 — no successful run for 25 min. With no run at all, judge from how long
    // runs could have existed (first run, else this process's uptime).
    const reference = snapshot.lastSuccessAt ?? snapshot.firstEverAt ?? processStartedAt;
    if (age(reference) > NO_SUCCESS_AFTER_MS) {
      conditions.push({ code: 'A1', severity: 'P1', detail: `no successful expiry run since ${snapshot.lastSuccessAt?.toISOString() ?? 'ever'}` });
    }
    // A9 — no run started at all for 25 min (worker or schedule missing rather than runs failing).
    if (age(snapshot.lastStartedAt ?? processStartedAt) > NO_SUCCESS_AFTER_MS) {
      conditions.push({ code: 'A9', severity: 'P1', detail: `no expiry run started since ${snapshot.lastStartedAt?.toISOString() ?? 'ever'}` });
    }
    const latest = recent[0];
    // A2 / A3 / A15 — failed, repeatedly failing, partial runs.
    if (recent.length === 3 && recent.every((r) => r.status === 'FAILED' || r.status === 'PARTIAL')) {
      conditions.push({ code: 'A3', severity: 'P1', detail: '3 consecutive expiry runs FAILED or PARTIAL' });
    } else if (latest?.status === 'FAILED') {
      conditions.push({ code: 'A2', severity: 'P2', detail: `run ${latest.id} failed: ${latest.error ?? ''}` });
    } else if (latest?.status === 'PARTIAL' && (latest.failed ?? 0) > 0) {
      conditions.push({ code: 'A15', severity: 'P2', detail: `run ${latest.id}: ${latest.failed} group(s) failed` });
    }
    // A4 — a run beyond its budget + 1 min margin.
    if (snapshot.runningOverBudget > 0) {
      conditions.push({ code: 'A4', severity: 'P2', detail: `${snapshot.runningOverBudget} run(s) RUNNING for more than 5 min` });
    }
    // A5 — an eligible group more than 30 min past its deadline.
    if (overdue.count > 0) {
      conditions.push({
        code: 'A5',
        severity: 'P1',
        detail: `${overdue.count} abandoned checkout(s) overdue by more than 30 min; oldest created ${overdue.oldestCreatedAt?.toISOString()}`,
      });
    }
    // A6 — backlog at the start of the latest run.
    if ((latest?.backlogAtStart ?? 0) > BACKLOG_THRESHOLD) {
      const shrinking = recent.length < 3 || (recent[0].backlogAtStart ?? 0) < (recent[2].backlogAtStart ?? 0);
      conditions.push({ code: 'A6', severity: shrinking ? 'P3' : 'P2', detail: `backlog ${latest?.backlogAtStart} at run start` });
    }
    // A8 — the schedule had to be recreated often (Redis losing data).
    if (snapshot.scheduleRecreatedLast24h > 3) {
      conditions.push({ code: 'A8', severity: 'P2', detail: `schedule recreated ${snapshot.scheduleRecreatedLast24h} times in 24 h` });
    }
    // A10 — runs left RUNNING by dying processes.
    if (snapshot.staleClosedLastHour >= 2) {
      conditions.push({ code: 'A10', severity: 'P1', detail: `${snapshot.staleClosedLastHour} stale runs closed in the last hour (crash loop?)` });
    }
    // A14 — only the schedule owner knows its reconciler's failures.
    if (ownsExpirySchedule(this.configService.get<ProcessRole>('PROCESS_ROLE')) && this.jobsService.consecutiveReconcileFailures >= 5) {
      conditions.push({ code: 'A14', severity: 'P2', detail: `${this.jobsService.consecutiveReconcileFailures} consecutive failed schedule checks` });
    }

    return {
      status: conditions.some((c) => c.severity !== 'P3') ? 'alert' : 'ok',
      checkedAt: now.toISOString(),
      conditions,
    };
  }
}
