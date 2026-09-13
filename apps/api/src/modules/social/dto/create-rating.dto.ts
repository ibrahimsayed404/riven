import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';
import { RatingTargetType } from '@prisma/client';

export class CreateRatingDto {
  @IsEnum(RatingTargetType)
  targetType: RatingTargetType;

  @IsUUID()
  targetId: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  score: number;

  @IsOptional()
  @IsString()
  comment?: string;

  @IsUUID()
  orderId: string;
}
