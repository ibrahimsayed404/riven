import { Module } from '@nestjs/common';

import { BazaarsModule } from '../bazaars/bazaars.module';
import { DiscoveryService } from './discovery.service';
import { PublicDiscoveryController } from './public-discovery.controller';

// Imports BazaarsModule for its exported BazaarsService — discovery owns no
// tables and issues no Prisma calls of its own.
@Module({
  imports: [BazaarsModule],
  controllers: [PublicDiscoveryController],
  providers: [DiscoveryService],
})
export class DiscoveryModule {}
