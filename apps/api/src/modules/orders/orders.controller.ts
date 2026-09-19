import { Controller, Get, Param, ParseUUIDPipe, Patch, Query, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ListOrdersQueryDto } from './dto/list-orders-query.dto';
import { OrdersService } from './orders.service';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SHOPPER)
@Controller('orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Get()
  getOrders(@CurrentUser('id') userId: string, @Query() query: ListOrdersQueryDto) {
    return this.ordersService.getShopperOrders(userId, query.page ?? 1, query.limit ?? 20, query.status);
  }

  @Get(':id')
  getOrder(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.ordersService.getShopperOrder(userId, id);
  }

  /**
   * Cancels every PENDING order in this order's checkout group and releases
   * their stock; the response carries `cancelledOrderIds`. One Paymob
   * intention covers the group, so cancel is group-level (fix.js PAY-01).
   */
  @Patch(':id/cancel')
  cancelOrder(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.ordersService.cancelOrder(userId, id);
  }

  @Patch(':id/confirm-delivery')
  confirmDelivery(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.ordersService.confirmDelivery(userId, id);
  }
}
