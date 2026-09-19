import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Query, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { VendorsService } from '../vendors/vendors.service';
import { ListOrdersQueryDto } from './dto/list-orders-query.dto';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';
import { OrdersService } from './orders.service';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.VENDOR)
@Controller('vendors/me/orders')
export class VendorOrdersController {
  constructor(
    private readonly ordersService: OrdersService,
    private readonly vendorsService: VendorsService,
  ) {}

  private async getVendorId(userId: string): Promise<string> {
    const profile = await this.vendorsService.getMyProfile(userId);
    return profile.id;
  }

  @Get()
  async getOrders(@CurrentUser('id') userId: string, @Query() query: ListOrdersQueryDto) {
    const vendorId = await this.getVendorId(userId);
    return this.ordersService.getVendorOrders(vendorId, query.page ?? 1, query.limit ?? 20, query.status);
  }

  @Get(':id')
  async getOrder(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    const vendorId = await this.getVendorId(userId);
    return this.ordersService.getVendorOrder(vendorId, id);
  }

  @Patch(':id/status')
  async updateStatus(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateOrderStatusDto,
  ) {
    const vendorId = await this.getVendorId(userId);
    return this.ordersService.updateVendorOrderStatus(vendorId, id, dto.status);
  }
}
