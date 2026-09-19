import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

/**
 * The one way to page a list. Extend it for per-route filters. Every list
 * route used to parse `?page=&limit=` by hand with no upper bound, which made
 * `limit=1000000` a full-table dump and `limit=abc` a 500 (fix.js API-02).
 */
export class PaginationQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limit?: number = DEFAULT_PAGE_SIZE;
}

export interface PageMeta {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export function pageMeta(total: number, page: number, limit: number): PageMeta {
  return { total, page, limit, totalPages: Math.ceil(total / limit) };
}
