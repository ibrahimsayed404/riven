import { ArrayUnique, IsArray, IsIn, IsOptional } from 'class-validator';

import { SEARCH_INDEXES, SearchIndexName } from '../../../infra/search/search-index.config';

export class ReindexDto {
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsIn(SEARCH_INDEXES, { each: true })
  types?: SearchIndexName[];
}
