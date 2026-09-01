import { Controller, Get, Query } from '@nestjs/common';

import { DiscoveryService } from './discovery.service';
import { DiscoverBazaarsQueryDto } from './dto/discover-bazaars-query.dto';

// Public by design: no JwtAuthGuard. Anonymous shoppers browse this feed.
@Controller('discovery')
export class PublicDiscoveryController {
  constructor(private readonly discoveryService: DiscoveryService) {}

  @Get('bazaars')
  discoverBazaars(@Query() query: DiscoverBazaarsQueryDto) {
    return this.discoveryService.discoverBazaars(query);
  }
}
