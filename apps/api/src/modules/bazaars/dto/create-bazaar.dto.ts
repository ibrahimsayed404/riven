import { IsArray, IsDateString, IsEnum, IsLatitude, IsLongitude, IsNotEmpty, IsNumber, IsOptional, IsString } from 'class-validator';
import { ScheduleType } from '@prisma/client';

export class CreateBazaarDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsArray()
  @IsString({ each: true })
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
