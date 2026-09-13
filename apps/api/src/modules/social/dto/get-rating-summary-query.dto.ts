import { IsEnum, IsUUID } from 'class-validator';
import { RatingTargetType } from '@prisma/client';

export class GetRatingSummaryQueryDto {
  @IsEnum(RatingTargetType)
  targetType: RatingTargetType;

  @IsUUID()
  targetId: string;
}
