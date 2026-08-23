import { Controller, Get, Param, ParseIntPipe, ParseUUIDPipe, Patch, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { OrdersService } from './orders.service';
import { OrderStatus, Role } from '@prisma/client';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SHOPPER)
@Controller('orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Get()
  getOrders(
    @CurrentUser('id') userId: string,
    @Query('page') pageString?: string,
    @Query('limit') limitString?: string,
    @Query('status') status?: OrderStatus,
  ) {
    const page = pageString ? parseInt(pageString, 10) : 1;
    const limit = limitString ? parseInt(limitString, 10) : 10;
    return this.ordersService.getShopperOrders(userId, page, limit, status);
  }

  @Get(':id')
  getOrder(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.ordersService.getShopperOrder(userId, id);
  }

  @Patch(':id/cancel')
  cancelOrder(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.ordersService.cancelOrder(userId, id);
  }

  @Patch(':id/confirm-delivery')
  confirmDelivery(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.ordersService.confirmDelivery(userId, id);
  }
}
