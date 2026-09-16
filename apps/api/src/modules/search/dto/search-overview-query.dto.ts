import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

import { SearchBaseQueryDto } from './search-base-query.dto';

/** GET /search — grouped multi-index overview, page 1 of each requested type. */
export class SearchOverviewQueryDto extends SearchBaseQueryDto {
  // Comma-separated subset of products,vendors,bazaars. Parsed and validated in
  // the service so an unknown value gets the dedicated SEARCH_TYPE_INVALID code.
  @IsOptional()
  @IsString()
  types?: string;

  // Per type.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  limit?: number = 10;
}
