import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

// Bounds are generous but finite (fix.js API-03): the columns are TEXT and
// String[], so without these a vendor could store megabytes per product.
export const PRODUCT_TITLE_MAX = 200;
export const PRODUCT_DESCRIPTION_MAX = 5_000;
export const PRODUCT_IMAGES_MAX = 10;
export const PRICE_MAX = 1_000_000;

export class CreateProductDto {
  @IsString()
  @MinLength(1)
  @MaxLength(PRODUCT_TITLE_MAX)
  title!: string;

  @IsString()
  @MaxLength(PRODUCT_DESCRIPTION_MAX)
  description!: string;

  @IsUUID()
  categoryId!: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(PRICE_MAX)
  basePrice!: number;

  @IsArray()
  @ArrayMaxSize(PRODUCT_IMAGES_MAX)
  @IsUrl({ require_tld: false }, { each: true }) // require_tld: false keeps local MinIO URLs valid
  images!: string[];

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
