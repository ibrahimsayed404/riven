import { BazaarStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';

export class AdminListBazaarsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsEnum(BazaarStatus)
  status?: BazaarStatus;

  @IsOptional()
  @IsUUID()
  organizerId?: string;

  /** Case-insensitive match on the bazaar name. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  includeDeleted?: boolean = false;
}
