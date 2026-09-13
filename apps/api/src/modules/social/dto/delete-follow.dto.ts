import { IsEnum, IsUUID } from 'class-validator';
import { FollowableType } from '@prisma/client';

export class DeleteFollowDto {
  @IsEnum(FollowableType)
  followableType: FollowableType;

  @IsUUID()
  followableId: string;
}
