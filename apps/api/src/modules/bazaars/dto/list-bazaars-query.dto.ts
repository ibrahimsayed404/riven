import { IsEnum, IsNumber, IsOptional, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ScheduleType } from '@prisma/client';

import { MAX_PAGE_SIZE } from '../../../common/dto/pagination-query.dto';

export class ListBazaarsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  lat?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  lng?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.1)
  radiusKm?: number;

  @IsOptional()
  @IsEnum(ScheduleType)
  scheduleType?: ScheduleType;
}
