import { Module } from '@nestjs/common';
import { VendorsController } from './vendors.controller';
import { VendorsService } from './vendors.service';
import { VendorsRepository } from './vendors.repository';
import { AdminVendorsController } from './admin-vendors.controller';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [AuditModule],
  controllers: [VendorsController, AdminVendorsController],
  providers: [VendorsService, VendorsRepository],
  exports: [VendorsService],
})
export class VendorsModule {}
