import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';
import { RatingTargetType } from '@prisma/client';

export class GetRatingsQueryDto {
  @IsEnum(RatingTargetType)
  targetType: RatingTargetType;

  @IsUUID()
  targetId: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @IsOptional()
  @IsString()
  cursor?: string;
}
