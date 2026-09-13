import { IsEnum, IsUUID } from 'class-validator';
import { FavorableType } from '@prisma/client';

export class DeleteFavoriteDto {
  @IsEnum(FavorableType)
  favorableType: FavorableType;

  @IsUUID()
  favorableId: string;
}
