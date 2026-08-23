import { VendorType } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MinLength } from 'class-validator';
import { OmitType } from '@nestjs/mapped-types';
import { RegisterDto } from './register.dto';

export class RegisterVendorDto extends OmitType(RegisterDto, ['role'] as const) {
  @IsString()
  @MinLength(1)
  businessName!: string;

  @IsString()
  @MinLength(1)
  category!: string;

  @IsEnum(VendorType)
  vendorType!: VendorType;

  @IsOptional()
  @IsString()
  description?: string;
}
