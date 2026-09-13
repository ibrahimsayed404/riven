import { Controller, Get, Query, UseGuards } from '@nestjs/common';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import { DiscoveryService } from './discovery.service';
import { DiscoverBazaarsQueryDto } from './dto/discover-bazaars-query.dto';

// Public with optional auth context: anonymous shoppers browse feeds without auth,
// but authenticated shoppers get personalized fields like isFavorite.
@UseGuards(OptionalJwtAuthGuard)
@Controller('discovery')
export class PublicDiscoveryController {
  constructor(private readonly discoveryService: DiscoveryService) {}

  @Get('bazaars')
  discoverBazaars(
    @Query() query: DiscoverBazaarsQueryDto,
    @CurrentUser('id') userId?: string,
  ) {
    return this.discoveryService.discoverBazaars(query, userId);
  }
}
