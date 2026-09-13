import { IsEnum, IsUUID } from 'class-validator';
import { FavorableType } from '@prisma/client';

export class CreateFavoriteDto {
  @IsEnum(FavorableType)
  favorableType: FavorableType;

  @IsUUID()
  favorableId: string;
}
