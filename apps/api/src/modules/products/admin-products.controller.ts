import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Query, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { ProductsService } from './products.service';
import { AdminListProductsQueryDto } from './dto/admin-list-products-query.dto';
import { AdminUpdateProductDto } from './dto/admin-update-product.dto';

@Controller('admin/products')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class AdminProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Get()
  listProducts(@Query() query: AdminListProductsQueryDto) {
    return this.productsService.listForAdmin({
      vendorId: query.vendorId,
      page: query.page ?? 1,
      limit: query.limit ?? 20,
    });
  }

  /** Inactive and soft-deleted included (specs/admin-module-spec2.md A2). */
  @Get(':id')
  getProduct(@Param('id') id: string) {
    return this.productsService.getProductForAdmin(id);
  }

  /** Text and images only; approval state is untouched (specs/admin-module-spec3.md B2). */
  @Patch(':id')
  updateProduct(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: AdminUpdateProductDto,
  ) {
    return this.productsService.updateProductForAdmin(admin.id, id, dto);
  }

  /** Soft delete; repeating it is a no-op (specs/admin-module-spec3.md B3a). */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteProduct(@CurrentUser() admin: AuthenticatedUser, @Param('id') id: string) {
    return this.productsService.deleteProductForAdmin(admin.id, id);
  }
}
