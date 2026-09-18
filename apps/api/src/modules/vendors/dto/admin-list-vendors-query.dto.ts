import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

import { VENDOR_MODERATION_STATUSES, VendorModerationStatus } from '../vendors.repository';

export class AdminListVendorsQueryDto {
  @IsOptional()
  @IsIn(VENDOR_MODERATION_STATUSES)
  status?: VendorModerationStatus;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}
