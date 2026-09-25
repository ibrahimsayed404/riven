import { Module } from '@nestjs/common';

import { BazaarsModule } from '../bazaars/bazaars.module';
import { OrdersModule } from '../orders/orders.module';
import { ProductsModule } from '../products/products.module';
import { VendorsModule } from '../vendors/vendors.module';
import { AuditModule } from '../audit/audit.module';
import { AdminRatingsController } from './admin-ratings.controller';
import { SocialController } from './social.controller';
import { SocialRepository } from './social.repository';
import { SocialService } from './social.service';

// Vendors / Bazaars / Products are imported only to confirm a follow or
// favorite target is publicly visible (fix.js VULN-04), through their services.
@Module({
  imports: [OrdersModule, VendorsModule, BazaarsModule, ProductsModule, AuditModule],
  controllers: [AdminRatingsController, SocialController],
  providers: [SocialService, SocialRepository],
  exports: [SocialService],
})
export class SocialModule {}
