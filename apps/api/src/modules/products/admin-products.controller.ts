import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Query, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { ProductsService } from './products.service';
import { AdminListProductsQueryDto } from './dto/admin-list-products-query.dto';
import { RejectProductDto } from './dto/reject-product.dto';

@Controller('admin/products')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class AdminProductsController {
  constructor(private readonly productsService: ProductsService) {}

  /** Moderation queue. `?approvalStatus=PENDING` is the "needs a decision" view. */
  @Get()
  listProducts(@Query() query: AdminListProductsQueryDto) {
    return this.productsService.listForAdmin({
      approvalStatus: query.approvalStatus,
      vendorId: query.vendorId,
      page: query.page ?? 1,
      limit: query.limit ?? 20,
    });
  }

  /** Any approval state, inactive and soft-deleted included (specs/admin-module-spec2.md A2). */
  @Get(':id')
  getProduct(@Param('id') id: string) {
    return this.productsService.getProductForAdmin(id);
  }

  @Patch(':id/approve')
  @HttpCode(HttpStatus.OK)
  approveProduct(@CurrentUser() admin: AuthenticatedUser, @Param('id') id: string) {
    return this.productsService.approveProduct(admin.id, id);
  }

  @Patch(':id/reject')
  @HttpCode(HttpStatus.OK)
  rejectProduct(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id') id: string,
    @Body() rejectDto: RejectProductDto,
  ) {
    return this.productsService.rejectProduct(admin.id, id, rejectDto.reason);
  }
}
