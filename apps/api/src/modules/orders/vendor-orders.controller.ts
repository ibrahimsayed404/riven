import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { OrdersService } from './orders.service';
import { OrderStatus, Role } from '@prisma/client';
import { VendorsService } from '../vendors/vendors.service';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';

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
  async getOrders(
    @CurrentUser('id') userId: string,
    @Query('page') pageString?: string,
    @Query('limit') limitString?: string,
    @Query('status') status?: OrderStatus,
  ) {
    const vendorId = await this.getVendorId(userId);
    const page = pageString ? parseInt(pageString, 10) : 1;
    const limit = limitString ? parseInt(limitString, 10) : 10;
    return this.ordersService.getVendorOrders(vendorId, page, limit, status);
  }

  @Get(':id')
  async getOrder(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
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
