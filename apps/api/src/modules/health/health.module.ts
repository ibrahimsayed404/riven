import { Module } from '@nestjs/common';

import { PaymobModule } from '../../infra/paymob/paymob.module';
import { CheckoutModule } from '../checkout/checkout.module';
import { OrdersJobsModule } from '../orders/jobs/orders-jobs.module';
import { OutboxModule } from '../outbox/outbox.module';
import { ProductsModule } from '../products/products.module';
import { HealthController } from './health.controller';
import { HealthRepository } from './health.repository';
import { HealthTokenGuard } from './health-token.guard';
import { HealthService } from './health.service';

@Module({
  imports: [OrdersJobsModule, OutboxModule, CheckoutModule, PaymobModule, ProductsModule],
  controllers: [HealthController],
  providers: [HealthService, HealthRepository, HealthTokenGuard],
})
export class HealthModule {}
