import { OrderStatus } from '@prisma/client';
import { IsEnum, IsOptional } from 'class-validator';

import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';

export class ListOrdersQueryDto extends PaginationQueryDto {
  // Was a raw string cast to OrderStatus: `?status=FOO` reached Prisma and 500'd (fix.js API-02).
  @IsOptional()
  @IsEnum(OrderStatus)
  status?: OrderStatus;
}
