import { Module } from '@nestjs/common';
import { BoothsService } from './booths.service';
import { BoothsRepository } from './booths.repository';
import { AdminBoothsController } from './admin-booths.controller';
import { PublicBoothsController } from './public-booths.controller';
import { BazaarsModule } from '../bazaars/bazaars.module';

@Module({
  imports: [BazaarsModule],
  controllers: [AdminBoothsController, PublicBoothsController],
  providers: [BoothsService, BoothsRepository],
  exports: [BoothsService, BoothsRepository],
})
export class BoothsModule {}
