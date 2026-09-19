import { VendorCategory, VendorType } from '@prisma/client';
import { IsEnum, IsOptional } from 'class-validator';

import { PagedSearchQueryDto } from './search-base-query.dto';

export class SearchVendorsQueryDto extends PagedSearchQueryDto {
  // An enum now (fix.js SCHEMA-02): the index stores the enum value, so the
  // filter is exact instead of a case-sensitive free-text match.
  @IsOptional()
  @IsEnum(VendorCategory)
  category?: VendorCategory;

  @IsOptional()
  @IsEnum(VendorType)
  vendorType?: VendorType;
}
