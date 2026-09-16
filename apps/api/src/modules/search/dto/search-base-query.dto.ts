import { Transform, Type } from 'class-transformer';
import { IsInt, IsNumber, IsOptional, IsString, Length, Max, Min, ValidateIf } from 'class-validator';

export const SEARCH_QUERY_MAX_LENGTH = 100;
export const SEARCH_DEFAULT_RADIUS_KM = 25;

/**
 * Shared by every search endpoint: the query text and optional coordinates.
 * Cross-field rules that class-validator cannot express cleanly (radiusKm
 * without coordinates, maxPrice < minPrice) are enforced in SearchService.
 */
export class SearchBaseQueryDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(1, SEARCH_QUERY_MAX_LENGTH)
  q!: string;

  // Not @IsOptional: lat and lng must arrive together or not at all, same
  // pattern as DiscoverBazaarsQueryDto.
  @ValidateIf((o) => o.lat !== undefined || o.lng !== undefined)
  @Type(() => Number)
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat?: number;

  @ValidateIf((o) => o.lat !== undefined || o.lng !== undefined)
  @Type(() => Number)
  @IsNumber()
  @Min(-180)
  @Max(180)
  lng?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(150)
  radiusKm?: number;
}

/** Per-type endpoints add offset pagination on top of the base query. */
export class PagedSearchQueryDto extends SearchBaseQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number = 20;
}
