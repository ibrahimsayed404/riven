import { IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

import { PRICE_MAX } from './create-product.dto';

export const STOCK_MAX = 1_000_000;

export class CreateProductVariantDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  sku!: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  size?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  color?: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(PRICE_MAX)
  priceOverride?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(STOCK_MAX)
  stockQuantity?: number;
}
