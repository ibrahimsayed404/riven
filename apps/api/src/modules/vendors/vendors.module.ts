import { Module } from '@nestjs/common';
import { VendorsController } from './vendors.controller';
import { VendorsService } from './vendors.service';
import { VendorsRepository } from './vendors.repository';
import { AdminVendorsController } from './admin-vendors.controller';

@Module({
  controllers: [VendorsController, AdminVendorsController],
  providers: [VendorsService, VendorsRepository],
  exports: [VendorsService, VendorsRepository],
})
export class VendorsModule {}
