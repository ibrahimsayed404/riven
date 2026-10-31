import { ArrayMaxSize, IsArray, IsDateString, IsEnum, IsLatitude, IsLongitude, IsNotEmpty, IsNumber, IsOptional, IsString, IsUrl } from 'class-validator';
import { ScheduleType } from '@prisma/client';

export class CreateBazaarDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsString()
  @IsOptional()
  description?: string;

  // Same rule as a vendor's coverMedia: URLs only (no javascript: or data:
  // strings a client would render), require_tld: false for local MinIO.
  @IsArray()
  @ArrayMaxSize(10)
  @IsUrl({ require_tld: false, require_protocol: true, protocols: ['http', 'https'] }, { each: true })
  @IsOptional()
  coverMedia?: string[];

  @IsNumber()
  @IsLatitude()
  lat!: number;

  @IsNumber()
  @IsLongitude()
  lng!: number;

  @IsEnum(ScheduleType)
  scheduleType!: ScheduleType;

  @IsString()
  @IsOptional()
  recurrenceRule?: string;

  @IsDateString()
  startDate!: string;

  @IsDateString()
  @IsOptional()
  endDate?: string;
}
