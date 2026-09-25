import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module';
import { VendorsModule } from '../vendors/vendors.module';
import { AdminOrdersController } from './admin-orders.controller';
import { OrdersExpiryProcessor } from './jobs/orders-expiry.processor';
import { ORDERS_QUEUE, OrdersJobsService } from './jobs/orders-jobs.service';
import { OrdersController } from './orders.controller';
import { OrdersRepository } from './orders.repository';
import { OrdersService } from './orders.service';
import { VendorOrdersController } from './vendor-orders.controller';

@Module({
  imports: [VendorsModule, AuditModule, BullModule.registerQueue({ name: ORDERS_QUEUE })],
  controllers: [AdminOrdersController, OrdersController, VendorOrdersController],
  providers: [OrdersService, OrdersRepository, OrdersJobsService, OrdersExpiryProcessor],
  exports: [OrdersService],
})
export class OrdersModule {}
