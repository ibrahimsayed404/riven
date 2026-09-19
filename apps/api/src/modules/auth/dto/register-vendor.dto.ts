import { VendorCategory, VendorType } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { OmitType } from '@nestjs/mapped-types';
import { RegisterDto } from './register.dto';

export class RegisterVendorDto extends OmitType(RegisterDto, ['role'] as const) {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  businessName!: string;

  // Was free text ("Food", "FASHION", "fashion" all coexisted) — fix.js SCHEMA-02.
  @IsEnum(VendorCategory)
  category!: VendorCategory;

  @IsEnum(VendorType)
  vendorType!: VendorType;

  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  description?: string;
}
