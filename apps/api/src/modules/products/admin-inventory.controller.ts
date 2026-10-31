import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';

import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { DEFAULT_PAGE_SIZE } from '../../common/dto/pagination-query.dto';
import { AdminListInventoryMovementsQueryDto } from './dto/admin-list-inventory-movements-query.dto';
import { ProductsService } from './products.service';

// specs/commerce/25 S3: the stock ledger, read-only. Every change of a
// variant's stock — checkout, cancel, expiry, vendor adjustment — is one row.
@Controller('admin/inventory-movements')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class AdminInventoryController {
  constructor(private readonly productsService: ProductsService) {}

  @Get()
  listMovements(@Query() query: AdminListInventoryMovementsQueryDto) {
    return this.productsService.listInventoryMovementsForAdmin({
      variantId: query.variantId,
      productId: query.productId,
      orderGroupId: query.orderGroupId,
      type: query.type,
      page: query.page ?? 1,
      limit: query.limit ?? DEFAULT_PAGE_SIZE,
    });
  }
}
