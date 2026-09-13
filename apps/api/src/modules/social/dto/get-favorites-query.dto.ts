import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { FavorableType } from '@prisma/client';

export class GetFavoritesQueryDto {
  @IsOptional()
  @IsEnum(FavorableType)
  favorableType?: FavorableType;

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
