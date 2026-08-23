import { Controller, HttpCode, HttpStatus, Param, Patch, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { VendorsService } from './vendors.service';

@Controller('admin/vendors')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class AdminVendorsController {
  constructor(private readonly vendorsService: VendorsService) {}

  @Patch(':id/verify')
  @HttpCode(HttpStatus.OK)
  async verifyVendor(@Param('id') id: string) {
    const updated = await this.vendorsService.verifyVendor(id);
    return { id: updated.id, verified: updated.verified };
  }
}
