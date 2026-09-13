import { Module } from '@nestjs/common';

import { BazaarsModule } from '../bazaars/bazaars.module';
import { SocialModule } from '../social/social.module';
import { DiscoveryService } from './discovery.service';
import { PublicDiscoveryController } from './public-discovery.controller';

// Imports BazaarsModule and SocialModule for their exported services — discovery
// owns no tables and issues no Prisma calls of its own.
@Module({
  imports: [BazaarsModule, SocialModule],
  controllers: [PublicDiscoveryController],
  providers: [DiscoveryService],
})
export class DiscoveryModule {}
