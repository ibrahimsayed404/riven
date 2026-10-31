import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { AuditModule } from '../../audit/audit.module';
import { MaintenanceHealthService } from '../expiry/maintenance-health.service';
import { ReservationExpiryService } from '../expiry/reservation-expiry.service';
import { MaintenanceRunsRepository } from '../maintenance-runs.repository';
import { OrdersRepository } from '../orders.repository';
import { OrdersExpiryProcessor } from './orders-expiry.processor';
import { ORDERS_QUEUE, OrdersJobsService } from './orders-jobs.service';

/**
 * Reservation maintenance only: the expiry service, its schedule owner, the
 * orders-queue worker and the maintenance health evaluation. Imported by
 * OrdersModule and HealthModule (API) and by WorkerModule (the dedicated worker
 * entry point, TD-22) — the worker loads nothing else.
 */
@Module({
  imports: [AuditModule, BullModule.registerQueue({ name: ORDERS_QUEUE })],
  providers: [
    OrdersRepository,
    MaintenanceRunsRepository,
    ReservationExpiryService,
    OrdersJobsService,
    OrdersExpiryProcessor,
    MaintenanceHealthService,
  ],
  exports: [ReservationExpiryService, OrdersJobsService, MaintenanceHealthService],
})
export class OrdersJobsModule {}
