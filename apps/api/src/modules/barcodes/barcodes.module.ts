import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module';
import { AdminBarcodesController } from './admin-barcodes.controller';
import { BarcodesRepository } from './barcodes.repository';
import { BarcodesService } from './barcodes.service';
import { VendorBarcodesController } from './vendor-barcodes.controller';

/** Barcode registry (riven-barcode-inventory-plan B1). Scanning (B2) will use BarcodesService.resolve. */
@Module({
  imports: [AuditModule],
  controllers: [VendorBarcodesController, AdminBarcodesController],
  providers: [BarcodesService, BarcodesRepository],
  exports: [BarcodesService],
})
export class BarcodesModule {}
