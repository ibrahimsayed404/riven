import { IsInt, IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class CreateProductVariantDto {
  @IsString()
  sku!: string;

  @IsOptional()
  @IsString()
  size?: string;

  @IsOptional()
  @IsString()
  color?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  priceOverride?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  stockQuantity?: number;
}
