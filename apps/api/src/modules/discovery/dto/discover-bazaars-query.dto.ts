import { Transform, Type } from "class-transformer";
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateIf,
} from "class-validator";
import { ScheduleType } from "@prisma/client";

export class DiscoverBazaarsQueryDto {
  // Not @IsOptional: lat and lng must arrive together or not at all.
  // ValidateIf makes each one required as soon as its sibling is present.
  @ValidateIf((o) => o.lat !== undefined || o.lng !== undefined)
  @Type(() => Number)
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat?: number;

  @ValidateIf((o) => o.lat !== undefined || o.lng !== undefined)
  @Type(() => Number)
  @IsNumber()
  @Min(-180)
  @Max(180)
  lng?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(150)
  radiusKm?: number = 25;

  @IsOptional()
  @IsEnum(ScheduleType)
  scheduleType?: ScheduleType;

  @IsOptional()
  @Transform(({ value }) => {
    if (value === undefined) return true;
    if (value === "true") return true;
    if (value === "false") return false;
    return value; // leave the raw string so @IsBoolean rejects it
  })
  @IsBoolean()
  upcomingOnly?: boolean = true;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number = 20;

  @IsOptional()
  @IsString()
  cursor?: string;
}
