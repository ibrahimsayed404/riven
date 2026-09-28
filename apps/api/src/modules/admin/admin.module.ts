import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module';
import { BazaarsModule } from '../bazaars/bazaars.module';
import { OrdersModule } from '../orders/orders.module';
import { UsersModule } from '../users/users.module';
import { VendorsModule } from '../vendors/vendors.module';
import { AdminAuditLogController } from './admin-audit-log.controller';
import { AdminOverviewController } from './admin-overview.controller';
import { AdminOverviewService } from './admin-overview.service';

// Cross-cutting admin surface only: what has no domain home. Approval
// endpoints live in their domain modules (admin-vendors.controller.ts, ...).
// Talks to other modules through their exported services, never a repository.
@Module({
  imports: [AuditModule, VendorsModule, BazaarsModule, UsersModule, OrdersModule],
  controllers: [AdminOverviewController, AdminAuditLogController],
  providers: [AdminOverviewService],
})
export class AdminModule {}
