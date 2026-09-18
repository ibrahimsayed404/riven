import { Module } from '@nestjs/common';

import { AuditRepository } from './audit.repository';
import { AuditService } from './audit.service';

// Leaf module: depends on the global PrismaModule only. Domain modules import
// it to write audit rows; AdminModule imports it to read them. Keeping it out
// of AdminModule avoids a Vendors -> Admin -> Vendors import cycle.
@Module({
  providers: [AuditService, AuditRepository],
  exports: [AuditService],
})
export class AuditModule {}
