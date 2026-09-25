import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';

import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { DEFAULT_PAGE_SIZE } from '../../common/dto/pagination-query.dto';
import { AdminListOrdersQueryDto } from './dto/admin-list-orders-query.dto';
import { OrdersService } from './orders.service';

// specs/admin-module-spec2.md A5. Read-only: admin status changes, cancel and
// refund are Open Item B6 (refunds need the Payments spec first).
@Controller('admin/orders')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class AdminOrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  /** Every order of every shopper and vendor, newest first. */
  @Get()
  listOrders(@Query() query: AdminListOrdersQueryDto) {
    return this.ordersService.listForAdmin({
      status: query.status,
      vendorId: query.vendorId,
      userId: query.userId,
      orderGroupId: query.orderGroupId,
      page: query.page ?? 1,
      limit: query.limit ?? DEFAULT_PAGE_SIZE,
    });
  }

  @Get(':id')
  getOrder(@Param('id') id: string) {
    return this.ordersService.getOrderForAdmin(id);
  }
}
