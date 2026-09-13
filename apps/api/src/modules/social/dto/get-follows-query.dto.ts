import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { FollowableType } from '@prisma/client';

export class GetFollowsQueryDto {
  @IsOptional()
  @IsEnum(FollowableType)
  followableType?: FollowableType;

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
