import { Type } from 'class-transformer';
import { IsIn, IsNumber, IsOptional, IsString, IsUUID, Length, Min } from 'class-validator';

import { PagedSearchQueryDto } from './search-base-query.dto';

export const PRODUCT_SORT_OPTIONS = ['price:asc', 'price:desc'] as const;
export type ProductSort = (typeof PRODUCT_SORT_OPTIONS)[number];

/**
 * GET /search/products. lat/lng/radiusKm are inherited, accepted and ignored:
 * products carry no _geo in v1, and a single client search bar should be able
 * to pass location to every endpoint without special-casing this one.
 */
export class SearchProductsQueryDto extends PagedSearchQueryDto {
  /** Exact leaf category. */
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  /** Category slug — matches this category and everything under it. */
  @IsOptional()
  @IsString()
  @Length(1, 100)
  category?: string;

  @IsOptional()
  @IsUUID()
  vendorId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  minPrice?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  maxPrice?: number;

  @IsOptional()
  @IsString()
  @Length(1, 50)
  size?: string;

  @IsOptional()
  @IsString()
  @Length(1, 50)
  color?: string;

  @IsOptional()
  @IsIn(PRODUCT_SORT_OPTIONS)
  sort?: ProductSort;
}
