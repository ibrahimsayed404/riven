import { IsOptional, IsString, Length } from 'class-validator';

/** Optional note for the audit log (BoothListing has no reason column). */
export class AdminRejectApplicationDto {
  @IsOptional()
  @IsString()
  @Length(1, 1000)
  reason?: string;
}
