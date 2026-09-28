import { ApplicationStatus } from '@prisma/client';
import { IsEnum, IsOptional } from 'class-validator';

import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';

/**
 * The two booth-application lists (organizer's per-bazaar queue, vendor's own
 * applications). `status` used to be a raw string annotated as the enum, so
 * `?status=FOO` reached Prisma and came back as a 500 — the same defect
 * ListOrdersQueryDto was fixed for.
 */
export class ListApplicationsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsEnum(ApplicationStatus)
  status?: ApplicationStatus;
}
