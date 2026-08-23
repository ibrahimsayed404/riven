import { Module } from '@nestjs/common';
import { OrdersController } from './orders.controller';
import { VendorOrdersController } from './vendor-orders.controller';
import { OrdersService } from './orders.service';
import { OrdersRepository } from './orders.repository';
import { VendorsModule } from '../vendors/vendors.module';

@Module({
  imports: [VendorsModule],
  controllers: [OrdersController, VendorOrdersController],
  providers: [OrdersService, OrdersRepository],
})
export class OrdersModule {}
