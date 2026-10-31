import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';
import { BarcodeStatus, PackagingType } from '@prisma/client';

import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';

const MAX_UNITS = 100_000;

export class ProposeBarcodeDto {
  @IsUUID()
  variantId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(256) // raw input; normalized to ≤ 128 in the service
  value!: string;

  @IsEnum(PackagingType)
  packagingType!: PackagingType;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_UNITS)
  unitsPerPackage?: number;
}

export class CreateInternalBarcodeDto {
  @IsUUID()
  variantId!: string;

  @IsEnum(PackagingType)
  packagingType!: PackagingType;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_UNITS)
  unitsPerPackage?: number;
}

export class RegisterVendorBarcodeDto extends ProposeBarcodeDto {
  @IsUUID()
  vendorId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  reason!: string;
}

export class BarcodeReasonDto {
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  reason!: string;
}

export class ChangeConversionDto extends BarcodeReasonDto {
  @Type(() => Number)
  @IsInt()
  @Min(2)
  @Max(MAX_UNITS)
  unitsPerPackage!: number;
}

export class LookupBarcodeDto {
  @IsString()
  @MinLength(1)
  @MaxLength(256)
  value!: string;

  @IsUUID()
  vendorId!: string;
}

export class ListOwnBarcodesQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsEnum(BarcodeStatus)
  status?: BarcodeStatus;
}

export class AdminListBarcodesQueryDto extends ListOwnBarcodesQueryDto {
  @IsOptional()
  @IsUUID()
  vendorId?: string;

  @IsOptional()
  @IsUUID()
  variantId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  value?: string;
}
