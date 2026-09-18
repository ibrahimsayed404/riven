import { VendorType } from '@prisma/client';
import { IsEnum, IsOptional, IsString, Length } from 'class-validator';

import { PagedSearchQueryDto } from './search-base-query.dto';

export class SearchVendorsQueryDto extends PagedSearchQueryDto {
  @IsOptional()
  @IsString()
  @Length(1, 100)
  category?: string;

  @IsOptional()
  @IsEnum(VendorType)
  vendorType?: VendorType;
}
