import { Body, Controller, HttpCode, HttpStatus, Param, Patch, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { ProductsService } from './products.service';
import { RejectProductDto } from './dto/reject-product.dto';

@Controller('admin/products')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class AdminProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Patch(':id/approve')
  @HttpCode(HttpStatus.OK)
  async approveProduct(@Param('id') id: string) {
    const updated = await this.productsService.approveProduct(id);
    return { id: updated.id, approvalStatus: updated.approvalStatus, rejectionReason: updated.rejectionReason };
  }

  @Patch(':id/reject')
  @HttpCode(HttpStatus.OK)
  async rejectProduct(@Param('id') id: string, @Body() rejectDto: RejectProductDto) {
    const updated = await this.productsService.rejectProduct(id, rejectDto.reason);
    return { id: updated.id, approvalStatus: updated.approvalStatus, rejectionReason: updated.rejectionReason };
  }
}
