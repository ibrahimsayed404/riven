import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

import { ORGANIZER_MODERATION_STATUSES, OrganizerModerationStatus } from '../organizers.repository';

export class AdminListOrganizersQueryDto {
  @IsOptional()
  @IsIn(ORGANIZER_MODERATION_STATUSES)
  status?: OrganizerModerationStatus;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}
