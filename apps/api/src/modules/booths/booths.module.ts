import { Module } from '@nestjs/common';
import { BoothsService } from './booths.service';
import { BoothsRepository } from './booths.repository';
import { AdminBoothsController } from './admin-booths.controller';
import { PublicBoothsController } from './public-booths.controller';
import { BazaarsModule } from '../bazaars/bazaars.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [BazaarsModule, AuditModule],
  controllers: [AdminBoothsController, PublicBoothsController],
  providers: [BoothsService, BoothsRepository],
  exports: [BoothsService],
})
export class BoothsModule {}
