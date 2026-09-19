import { VendorCategory, VendorType } from '@prisma/client';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  MinLength,
} from 'class-validator';

const URL_OPTS = { require_tld: false }; // local MinIO URLs have no TLD

export class UpdateVendorProfileDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  businessName?: string; // name in DB

  @IsOptional()
  @IsEnum(VendorCategory)
  category?: VendorCategory;

  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  description?: string;

  @IsOptional()
  @IsUrl(URL_OPTS)
  logo?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsUrl(URL_OPTS, { each: true })
  coverMedia?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(5_000)
  brandStory?: string;

  @IsOptional()
  @IsUrl(URL_OPTS)
  logoUrl?: string;

  @IsOptional()
  @IsUrl(URL_OPTS)
  bannerUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5_000)
  returnPolicy?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5_000)
  shippingPolicy?: string;

  @IsOptional()
  @IsEnum(VendorType)
  vendorType?: VendorType;

  @IsOptional()
  @IsBoolean()
  hasFixedLocation?: boolean;
}
