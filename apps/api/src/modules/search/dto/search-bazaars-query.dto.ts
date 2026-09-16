import { ScheduleType } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsOptional } from 'class-validator';

import { PagedSearchQueryDto } from './search-base-query.dto';

export class SearchBazaarsQueryDto extends PagedSearchQueryDto {
  @IsOptional()
  @IsEnum(ScheduleType)
  scheduleType?: ScheduleType;

  @IsOptional()
  @Transform(({ value }) => {
    if (value === undefined) return true;
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value; // leave the raw string so @IsBoolean rejects it
  })
  @IsBoolean()
  upcomingOnly?: boolean = true;
}
