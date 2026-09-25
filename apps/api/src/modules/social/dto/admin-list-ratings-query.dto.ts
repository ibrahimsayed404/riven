import { RatingTargetType } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';

export class AdminListRatingsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsEnum(RatingTargetType)
  targetType?: RatingTargetType;

  @IsOptional()
  @IsUUID()
  targetId?: string;

  /** The reviewer. */
  @IsOptional()
  @IsUUID()
  userId?: string;

  /** true → only ratings with a non-empty comment (the moderation view); false → only without. */
  @IsOptional()
  @Transform(({ value }) => (value === 'true' || value === true ? true : value === 'false' || value === false ? false : value))
  @IsBoolean()
  hasComment?: boolean;

  /** Only ratings scoring at most this — `maxScore=2` is the "low ratings" view. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  maxScore?: number;
}
