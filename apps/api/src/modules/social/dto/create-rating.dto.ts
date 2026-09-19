import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
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
  @MaxLength(2_000)
  comment?: string;

  /**
   * Required for VENDOR and PRODUCT (the delivered order that unlocks the
   * rating); omitted for BAZAAR, which any shopper may rate once it has run
   * (fix.js SPEC-03). The service enforces which applies.
   */
  @IsOptional()
  @IsUUID()
  orderId?: string;
}
