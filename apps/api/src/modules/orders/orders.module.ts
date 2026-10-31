import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module';
import { VendorsModule } from '../vendors/vendors.module';
import { AdminMaintenanceController } from './admin-maintenance.controller';
import { AdminOrdersController } from './admin-orders.controller';
import { OrdersJobsModule } from './jobs/orders-jobs.module';
import { OrdersController } from './orders.controller';
import { OrdersRepository } from './orders.repository';
import { OrdersService } from './orders.service';
import { VendorOrdersController } from './vendor-orders.controller';

@Module({
  imports: [VendorsModule, AuditModule, OrdersJobsModule],
  controllers: [AdminMaintenanceController, AdminOrdersController, OrdersController, VendorOrdersController],
  providers: [OrdersService, OrdersRepository],
  exports: [OrdersService],
})
export class OrdersModule {}
