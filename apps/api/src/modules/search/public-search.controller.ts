import { Controller, Get, Query, UseGuards } from '@nestjs/common';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import { SearchBazaarsQueryDto } from './dto/search-bazaars-query.dto';
import { SearchOverviewQueryDto } from './dto/search-overview-query.dto';
import { SearchProductsQueryDto } from './dto/search-products-query.dto';
import { SearchVendorsQueryDto } from './dto/search-vendors-query.dto';
import { SearchService } from './search.service';

// Public with optional auth, same as discovery: anonymous shoppers can search,
// authenticated shoppers additionally get isFavorite on each hit.
@UseGuards(OptionalJwtAuthGuard)
@Controller('search')
export class PublicSearchController {
  constructor(private readonly searchService: SearchService) {}

  @Get()
  searchAll(@Query() query: SearchOverviewQueryDto, @CurrentUser('id') userId?: string) {
    return this.searchService.searchAll(query, userId);
  }

  @Get('products')
  searchProducts(@Query() query: SearchProductsQueryDto, @CurrentUser('id') userId?: string) {
    return this.searchService.searchProducts(query, userId);
  }

  @Get('vendors')
  searchVendors(@Query() query: SearchVendorsQueryDto, @CurrentUser('id') userId?: string) {
    return this.searchService.searchVendors(query, userId);
  }

  @Get('bazaars')
  searchBazaars(@Query() query: SearchBazaarsQueryDto, @CurrentUser('id') userId?: string) {
    return this.searchService.searchBazaars(query, userId);
  }
}
