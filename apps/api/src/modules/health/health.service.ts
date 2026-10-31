import { Injectable, Logger } from '@nestjs/common';

import { PaymobEventsService } from '../../infra/paymob/paymob-events.service';
import { PaymentExceptionsService } from '../checkout/payment-exceptions.service';
import { ProductsService } from '../products/products.service';
import { MaintenanceHealth, MaintenanceHealthService } from '../orders/expiry/maintenance-health.service';
import { OrdersJobsService } from '../orders/jobs/orders-jobs.service';
import { OutboxService } from '../outbox/outbox.service';
import { HealthRepository } from './health.repository';

export interface DependencyHealth {
  status: 'ok' | 'alert';
  postgres: 'up' | 'down';
  redis: 'up' | 'down';
}

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(
    private readonly healthRepository: HealthRepository,
    private readonly jobsService: OrdersJobsService,
    private readonly maintenanceHealth: MaintenanceHealthService,
    private readonly outboxService: OutboxService,
    private readonly paymentExceptions: PaymentExceptionsService,
    private readonly paymobEvents: PaymobEventsService,
    private readonly productsService: ProductsService,
  ) {}

  /** A11 (Redis) and A13 (PostgreSQL). */
  async dependencies(): Promise<DependencyHealth> {
    const [postgres, redis] = await Promise.all([this.healthRepository.pingDatabase(), this.jobsService.pingRedis()]);
    return {
      status: postgres && redis ? 'ok' : 'alert',
      postgres: postgres ? 'up' : 'down',
      redis: redis ? 'up' : 'down',
    };
  }

  /**
   * A1 – A15 from PostgreSQL. If the evaluation itself cannot run, that is A13 —
   * reported as an alert, never as "no alert" (specs/commerce/21 §8.6).
   */
  async maintenance(): Promise<MaintenanceHealth> {
    try {
      const health = await this.maintenanceHealth.evaluate();
      // Outbox (01 §7.7; thresholds proposed, TBD with OD-02).
      const outbox = await this.outboxService.metrics();
      const now = Date.now();
      if (outbox.oldestPendingAt && now - outbox.oldestPendingAt.getTime() > 15 * 60_000) {
        health.conditions.push({ code: 'OBX-PENDING', severity: 'P2', detail: `oldest pending outbox delivery since ${outbox.oldestPendingAt.toISOString()}` });
      }
      if (outbox.expiredLeases > 0) {
        health.conditions.push({ code: 'OBX-LEASE', severity: 'P2', detail: `${outbox.expiredLeases} outbox deliveries PROCESSING with an expired lease` });
      }
      if (outbox.dead > 0) {
        health.conditions.push({ code: 'OBX-DEAD', severity: 'P2', detail: `${outbox.dead} DEAD outbox deliveries` });
      }
      // Charges recorded but not applied (double / late / wrong amount or currency;
      // specs/commerce/25 S1): someone owes a customer money or an explanation.
      const openPaymentExceptions = await this.paymentExceptions.countOpen();
      if (openPaymentExceptions > 0) {
        health.conditions.push({ code: 'PAY-EXC', severity: 'P2', detail: `${openPaymentExceptions} open payment exception(s) — GET /admin/payment-exceptions?status=OPEN` });
      }
      // A signed payment whose processing keeps failing waits only on Paymob's retries.
      const stuckPayments = await this.paymobEvents.countStuckPayments();
      if (stuckPayments > 0) {
        health.conditions.push({ code: 'PAY-STUCK', severity: 'P1', detail: `${stuckPayments} signed payment callback(s) unprocessed for over 15 minutes` });
      }
      // The stock ledger must add up to the counter for every variant (commerce/25 §10).
      const ledgerMismatches = await this.productsService.countLedgerMismatches();
      if (ledgerMismatches > 0) {
        health.conditions.push({ code: 'LEDGER-DRIFT', severity: 'P2', detail: `${ledgerMismatches} variant(s) whose stock ledger does not equal their stock — see scripts/ledger-catch-up.sql` });
      }
      if (health.conditions.some((c) => c.severity !== 'P3')) health.status = 'alert';
      return health;
    } catch (error) {
      this.logger.warn(`maintenance health evaluation failed: ${error instanceof Error ? error.message : String(error)}`);
      return {
        status: 'alert',
        checkedAt: new Date().toISOString(),
        conditions: [{ code: 'A13', severity: 'P1', detail: 'maintenance conditions could not be evaluated (PostgreSQL unavailable?)' }],
      };
    }
  }
}
