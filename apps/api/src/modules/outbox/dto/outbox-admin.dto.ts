import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { OutboxDeliveryStatus } from '@prisma/client';

import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import { OUTBOX_DRAIN_MAX } from '../outbox.constants';

export class ListOutboxQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsEnum(OutboxDeliveryStatus)
  status?: OutboxDeliveryStatus;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  consumer?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  type?: string;
}

export class DrainOutboxDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(OUTBOX_DRAIN_MAX)
  max?: number;
}

export class RequeueDeliveryDto {
  @IsString()
  @MinLength(10)
  @MaxLength(1000)
  reason!: string;
}
