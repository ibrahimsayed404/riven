import { VendorType } from '@prisma/client';
import { IsArray, IsBoolean, IsEnum, IsOptional, IsString, MinLength } from 'class-validator';

export class UpdateVendorProfileDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  businessName?: string; // name in DB

  @IsOptional()
  @IsString()
  @MinLength(1)
  category?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  logo?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  coverMedia?: string[];

  @IsOptional()
  @IsString()
  brandStory?: string;

  @IsOptional()
  @IsString()
  logoUrl?: string;

  @IsOptional()
  @IsString()
  bannerUrl?: string;

  @IsOptional()
  @IsString()
  returnPolicy?: string;

  @IsOptional()
  @IsString()
  shippingPolicy?: string;

  @IsOptional()
  @IsEnum(VendorType)
  vendorType?: VendorType;

  @IsOptional()
  @IsBoolean()
  hasFixedLocation?: boolean;
}
