import { IsInt, IsNotEmpty, IsUUID, Min } from 'class-validator';

export class AddCartItemDto {
  @IsUUID()
  @IsNotEmpty()
  productId: string;

  @IsUUID()
  @IsNotEmpty()
  variantId: string;

  @IsInt()
  @Min(1)
  quantity: number;
}
