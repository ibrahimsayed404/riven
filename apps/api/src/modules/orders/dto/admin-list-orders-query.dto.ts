import { IsOptional, IsUUID } from 'class-validator';

import { ListOrdersQueryDto } from './list-orders-query.dto';

/** The shopper/vendor list query (page, limit, status) plus admin-only party filters. */
export class AdminListOrdersQueryDto extends ListOrdersQueryDto {
  @IsOptional()
  @IsUUID()
  vendorId?: string;

  @IsOptional()
  @IsUUID()
  userId?: string;

  @IsOptional()
  @IsUUID()
  orderGroupId?: string;
}
